"""account_mapping: which account a transaction is journaled to.

resolve_expense_account decides where every bank and PayPal expense lands, so its order of
precedence is the rule that matters most: metadata category, then the normaliser's legacy code,
then the provider's invoice reference, then keywords, then the transaction type, then 8090
(which the journal posts as a draft for a person).
"""

import pytest

from ai_agent.services import account_mapping as accts
from ai_agent.services.account_mapping import (
    resolve_cash_account,
    resolve_expense_account,
)

# ── Cash accounts ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "source, currency, account",
    [
        ("paypal", "GBP", accts.PAYPAL_ACCOUNT),
        ("paypal", "USD", accts.PAYPAL_ACCOUNT),  # one PayPal account, any currency
        ("revolut", "GBP", accts.REVOLUT_GBP),
        ("revolut", "eur", accts.REVOLUT_EUR),
        ("revolut", "USD", accts.REVOLUT_USD),
        ("revolut", None, accts.REVOLUT_GBP),
        ("revolut", "ZAR", accts.REVOLUT_GBP),  # no ZAR account: the GBP one
    ],
)
def test_cash_account(source, currency, account):
    assert resolve_cash_account(source, currency) == account


# ── Precedence ──────────────────────────────────────────────────────────────────


def test_the_category_wins_over_everything_else():
    assert (
        resolve_expense_account(
            metadata={
                "expense_category": "legal",
                "account_code": "6200",
                "invoice_id": "CLICKANDDROP-1",
            },
            description="Shopify",
            transaction_type="fee",
        )
        == accts.LEGAL_FEES
    )


def test_the_legacy_code_wins_over_the_reference_and_keywords():
    assert (
        resolve_expense_account(
            metadata={"account_code": "6200", "invoice_id": "PISSX-1"},
            description="Slack",
        )
        == accts.OUTBOUND_SHIPPING
    )


def test_the_invoice_reference_wins_over_keywords():
    assert (
        resolve_expense_account(
            metadata={"invoice_id": "CLICKANDDROP-99"}, description="Slack"
        )
        == accts.OUTBOUND_SHIPPING
    )


def test_keywords_win_over_the_transaction_type():
    assert (
        resolve_expense_account(description="Slack", transaction_type="fee")
        == accts.TECHNOLOGY_SAAS
    )


@pytest.mark.parametrize(
    "txn_type, account",
    [("fee", accts.BANK_CHARGES), ("refund", accts.SALES_RETURNS)],
)
def test_the_type_decides_when_nothing_else_does(txn_type, account):
    assert (
        resolve_expense_account(description="zqxv", transaction_type=txn_type)
        == account
    )


def test_nothing_known_falls_back_to_8090():
    assert resolve_expense_account(description="zqxv") == accts.UNCATEGORISED_FALLBACK
    assert resolve_expense_account() == accts.MISCELLANEOUS_EXPENSE


# ── Categories and codes ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "category, account",
    sorted((k, v) for k, v in accts.CATEGORY_ACCOUNT_MAP.items() if v),
)
def test_each_category(category, account):
    assert resolve_expense_account(metadata={"expense_category": category}) == account


def test_miscellaneous_and_accounts_payable_categories_are_not_trusted():
    """Both fall through: accounts_payable once left Accounts Payable with debits no invoice
    ever credited."""
    for category in ("miscellaneous", "accounts_payable"):
        assert (
            resolve_expense_account(
                metadata={"expense_category": category}, description="Slack"
            )
            == accts.TECHNOLOGY_SAAS
        )
    assert "accounts_payable" not in accts.CATEGORY_ACCOUNT_MAP


@pytest.mark.parametrize("code, account", sorted(accts.NORMALISER_CODE_MAP.items()))
def test_each_legacy_code(code, account):
    assert resolve_expense_account(metadata={"account_code": code}) == account


def test_6999_is_never_used():
    assert "6999" not in accts.NORMALISER_CODE_MAP
    assert (
        resolve_expense_account(metadata={"account_code": "6999"})
        == accts.MISCELLANEOUS_EXPENSE
    )


# ── Invoice references ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "reference, amount, account",
    [
        ("CLICKANDDROP-123", 4.2, accts.OUTBOUND_SHIPPING),
        ("pissx-0042", 120, accts.COGS_CMT),  # under 300: a sampling run
        ("PISSX-0042", 299.99, accts.COGS_CMT),
        ("PISSX-0042", 300, accts.COGS_DEFAULT),  # a production purchase
        ("PISSX-0042", None, accts.COGS_DEFAULT),
        ("1Z999AA10123456784", 30, accts.COGS_DUTIES),  # a UPS tracking number
    ],
)
def test_invoice_reference(reference, amount, account):
    assert (
        resolve_expense_account(metadata={"invoice_id": reference}, amount=amount)
        == account
    )


# ── Keywords (one per group, as the comments in account_mapping describe them) ─


@pytest.mark.parametrize(
    "text, account",
    [
        ("Wellsuc7tb4", accts.INVENTORY_FINISHED_GOODS),
        ("Gocardless | Ref: 4FILMENT-YPV8WKQGV", accts.OUTBOUND_SHIPPING),
        ("Royal Mail", accts.OUTBOUND_SHIPPING),
        ("Openaiopcol Op", accts.TECHNOLOGY_SAAS),  # a garbled merchant descriptor
        ("Intuit Mailchimp", accts.MARKETING),
        ("Amazon Seller fees", accts.MARKETPLACE_FEES),
        ("Amazon", accts.COGS_PRODUCTION_SUPPLIES),
        ("Eurostar", accts.TRAVEL_ENTERTAINMENT),
        ("Booking.com", accts.TRAVEL_ENTERTAINMENT),
        ("Lime ride", accts.TRAVEL_ENTERTAINMENT),
        ("Hiscox insurance", accts.INSURANCE),
        ("Company Pro plan fee", accts.BANK_CHARGES),
        ("Park Cameras", accts.PHOTOGRAPHY),
        ("Conde Nast Vog", accts.PR_PRESS),
    ],
)
def test_keyword(text, account):
    assert resolve_expense_account(description=text) == account


def test_keywords_match_the_counterparty_too():
    assert (
        resolve_expense_account(description="Card payment", counterparty="Slack")
        == accts.TECHNOLOGY_SAAS
    )


def test_keywords_match_whole_words():
    """'Dropbox' is software; it must not read as 'box' (packaging)."""
    assert resolve_expense_account(description="Dropbox") == accts.TECHNOLOGY_SAAS
    assert (
        resolve_expense_account(description="Pinterest") == accts.MISCELLANEOUS_EXPENSE
    )


# ── What a rule can pick is a posting account ───────────────────────────────────


def _every_target():
    targets = set(accts.NORMALISER_CODE_MAP.values())
    targets |= {v for v in accts.CATEGORY_ACCOUNT_MAP.values() if v}
    targets |= {account for _, account in accts._KEYWORD_RULES}
    return targets


def test_no_rule_picks_miscellaneous():
    """8090 is only ever the fallback, so a journal on it is always a draft."""
    assert accts.MISCELLANEOUS_EXPENSE not in _every_target()


def test_every_target_is_a_four_digit_account_number():
    for target in _every_target():
        assert target.isdigit() and len(target) == 4, target
