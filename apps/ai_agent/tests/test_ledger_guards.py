"""The ledger's rules as the database enforces them (migration 20261108000000_ledger_guards).

Against the local Supabase database; skipped when it is not running. Every test works inside
a transaction that is rolled back, so nothing is left behind. The balance rule is deferred to
commit, so tests that expect it to refuse something make it immediate with SET CONSTRAINTS.
"""

import json
import os
import uuid
from datetime import date
from typing import Any, Dict, Iterator, List, Tuple

import psycopg2
import psycopg2.extensions
import pytest

LOCAL_DB = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)


@pytest.fixture
def db() -> Iterator[psycopg2.extensions.cursor]:
    try:
        conn = psycopg2.connect(LOCAL_DB, connect_timeout=2)
    except psycopg2.OperationalError as exc:
        raise pytest.skip.Exception("local Supabase database is not running") from exc
    cur = conn.cursor()
    cur.execute("select 1 from pg_trigger where tgname = 'trg_journal_lines_balance'")
    if cur.fetchone() is None:
        conn.close()
        pytest.skip("migration 20261108000000_ledger_guards is not applied locally")
    try:
        yield cur
    finally:
        conn.rollback()
        conn.close()


def _entity(cur) -> str:
    cur.execute("select id from entities order by created_at limit 1")
    row = cur.fetchone()
    if row is None:
        pytest.skip("the local database has no business (run pnpm db:fresh)")
    return str(row[0])


def _accounts(cur, n: int = 2) -> List[str]:
    cur.execute(
        "select id from chart_of_accounts where not is_header and status = 'active' "
        "order by account_number limit %s",
        (n,),
    )
    ids = [str(r[0]) for r in cur.fetchall()]
    assert len(ids) == n
    return ids


def _new_account(cur, *, is_header: bool = False, status: str = "active") -> str:
    cur.execute(
        "insert into chart_of_accounts (name, account_type, account_number, is_header, status) "
        "values ('Test account', 'expense', %s, %s, %s) returning id",
        (f"T{uuid.uuid4().hex[:8]}", is_header, status),
    )
    return str(cur.fetchone()[0])


def _upsert(
    cur,
    entity: str,
    lines: List[Tuple[str, float, float]],
    *,
    status: str = "posted",
    on: str = "2026-10-01",
) -> str:
    cur.execute(
        "select upsert_journal_with_lines(%s, %s, 'adjustment', 'test', 'test', %s, %s, '{}', %s)",
        (
            entity,
            on,
            str(uuid.uuid4()),
            status,
            json.dumps(
                [
                    {"account_id": a, "debit": d, "credit": c, "currency": "GBP"}
                    for a, d, c in lines
                ]
            ),
        ),
    )
    return str(cur.fetchone()[0])


def _check(cur) -> None:
    """Run the deferred balance check now rather than at commit."""
    cur.execute("set constraints all immediate")


# ── Balance ──────────────────────────────────────────────────────────────────────


def test_a_balanced_journal_is_accepted(db):
    a, b = _accounts(db)
    journal = _upsert(db, _entity(db), [(a, 100, 0), (b, 0, 100)])
    _check(db)
    db.execute(
        "select count(*) from journal_line_items where journal_id = %s", (journal,)
    )
    assert db.fetchone()[0] == 2


@pytest.mark.parametrize("status", ["posted", "draft"])
def test_an_unbalanced_journal_is_refused_whatever_its_status(db, status):
    a, b = _accounts(db)
    _upsert(db, _entity(db), [(a, 100, 0), (b, 0, 99)], status=status)
    with pytest.raises(psycopg2.Error, match="does not balance"):
        _check(db)


def test_the_balance_rule_runs_at_commit(db):
    """Without SET CONSTRAINTS the refusal comes when the transaction commits."""
    a, b = _accounts(db)
    _upsert(db, _entity(db), [(a, 100, 0), (b, 0, 50)])
    with pytest.raises(psycopg2.Error, match="does not balance"):
        db.connection.commit()


def test_one_penny_of_rounding_is_allowed(db):
    a, b = _accounts(db)
    _upsert(db, _entity(db), [(a, 70.94, 0), (b, 0, 70.95)])
    _check(db)


def test_two_pence_is_not(db):
    a, b = _accounts(db)
    _upsert(db, _entity(db), [(a, 70.93, 0), (b, 0, 70.95)])
    with pytest.raises(psycopg2.Error, match="does not balance"):
        _check(db)


def test_a_journal_can_be_written_line_by_line_in_one_transaction(db):
    a, b = _accounts(db)
    journal = _upsert(db, _entity(db), [(a, 40, 0), (b, 0, 40)])
    db.execute(
        "insert into journal_line_items (journal_id, account_id, debit, credit, currency) "
        "values (%s, %s, 10, 0, 'GBP')",
        (journal, a),
    )
    db.execute(
        "insert into journal_line_items (journal_id, account_id, debit, credit, currency) "
        "values (%s, %s, 0, 10, 'GBP')",
        (journal, b),
    )
    _check(db)


def test_changing_a_line_so_it_no_longer_balances_is_refused(db):
    a, b = _accounts(db)
    journal = _upsert(db, _entity(db), [(a, 100, 0), (b, 0, 100)])
    _check(db)
    db.execute("set constraints all deferred")
    db.execute(
        "update journal_line_items set debit = 120 where journal_id = %s and debit > 0",
        (journal,),
    )
    with pytest.raises(psycopg2.Error, match="does not balance"):
        _check(db)


def test_deleting_one_side_of_a_journal_is_refused(db):
    a, b = _accounts(db)
    journal = _upsert(db, _entity(db), [(a, 100, 0), (b, 0, 100)])
    _check(db)
    db.execute("set constraints all deferred")
    db.execute(
        "delete from journal_line_items where journal_id = %s and credit > 0",
        (journal,),
    )
    with pytest.raises(psycopg2.Error, match="does not balance"):
        _check(db)


def test_deleting_a_whole_journal_is_allowed(db):
    """The e2e restore helper deletes a journal's lines, then the journal."""
    a, b = _accounts(db)
    journal = _upsert(db, _entity(db), [(a, 100, 0), (b, 0, 100)])
    _check(db)
    db.execute("set constraints all deferred")
    db.execute("delete from journal_line_items where journal_id = %s", (journal,))
    db.execute("delete from journals where id = %s", (journal,))
    _check(db)


def test_moving_a_line_to_another_journal_checks_both(db):
    a, b = _accounts(db)
    entity = _entity(db)
    first = _upsert(db, entity, [(a, 100, 0), (b, 0, 100)])
    second = _upsert(db, entity, [(a, 5, 0), (b, 0, 5)])
    _check(db)
    db.execute("set constraints all deferred")
    db.execute(
        "update journal_line_items set journal_id = %s "
        "where journal_id = %s and credit > 0",
        (second, first),
    )
    with pytest.raises(psycopg2.Error, match="does not balance"):
        _check(db)


def test_replacing_a_journals_lines_through_the_upsert_still_balances(db):
    """Regenerating a journal (force) deletes and re-inserts its lines in one call."""
    a, b = _accounts(db)
    entity = _entity(db)
    source = str(uuid.uuid4())

    def write(amount: float) -> str:
        db.execute(
            "select upsert_journal_with_lines(%s, '2026-10-01', 'adjustment', 'test', "
            "'test', %s, 'posted', '{}', %s)",
            (
                entity,
                source,
                json.dumps(
                    [
                        {"account_id": a, "debit": amount, "credit": 0},
                        {"account_id": b, "debit": 0, "credit": amount},
                    ]
                ),
            ),
        )
        return str(db.fetchone()[0])

    assert write(100) == write(250)
    _check(db)


# ── Posting accounts ─────────────────────────────────────────────────────────────


def test_a_header_account_is_refused(db):
    (a,) = _accounts(db, 1)
    header = _new_account(db, is_header=True)
    with pytest.raises(psycopg2.Error, match="header account"):
        _upsert(db, _entity(db), [(a, 100, 0), (header, 0, 100)])


@pytest.mark.parametrize("status", ["inactive", "archived"])
def test_an_account_not_active_is_refused(db, status):
    (a,) = _accounts(db, 1)
    closed = _new_account(db, status=status)
    with pytest.raises(psycopg2.Error, match=f"is {status}"):
        _upsert(db, _entity(db), [(a, 100, 0), (closed, 0, 100)])


def test_posting_a_draft_onto_a_header_account_is_refused(db):
    """post_draft_journal repoints the 8090 line at the chosen account; it used to take any."""
    db.execute("select id from chart_of_accounts where account_number = '8090'")
    row = db.fetchone()
    if row is None:
        pytest.skip("the local chart has no 8090")
    misc = str(row[0])
    (cash,) = _accounts(db, 1)
    entity = _entity(db)
    draft = _upsert(db, entity, [(misc, 30, 0), (cash, 0, 30)], status="draft")
    header = _new_account(db, is_header=True)
    with pytest.raises(psycopg2.Error, match="header account"):
        db.execute("select post_draft_journal(%s, %s, %s)", (entity, draft, header))


def test_posting_a_draft_onto_a_posting_account_works(db):
    db.execute("select id from chart_of_accounts where account_number = '8090'")
    row = db.fetchone()
    if row is None:
        pytest.skip("the local chart has no 8090")
    misc = str(row[0])
    cash, expense = _accounts(db, 2)
    entity = _entity(db)
    draft = _upsert(db, entity, [(misc, 30, 0), (cash, 0, 30)], status="draft")
    db.execute("select post_draft_journal(%s, %s, %s)", (entity, draft, expense))
    db.execute("select status from journals where id = %s", (draft,))
    assert db.fetchone()[0] == "posted"
    _check(db)


# ── The rules that were already there ─────────────────────────────────────────────


def test_a_journal_with_no_lines_is_refused(db):
    with pytest.raises(psycopg2.Error, match="no line items"):
        _upsert(db, _entity(db), [])


def test_a_line_is_a_debit_or_a_credit(db):
    a, b = _accounts(db)
    with pytest.raises(psycopg2.Error, match="chk_debit_or_credit"):
        _upsert(db, _entity(db), [(a, 100, 100), (b, 0, 0)])


def test_one_journal_per_source_and_type(db):
    a, b = _accounts(db)
    entity = _entity(db)
    lines = json.dumps(
        [
            {"account_id": a, "debit": 10, "credit": 0},
            {"account_id": b, "debit": 0, "credit": 10},
        ]
    )
    source = str(uuid.uuid4())
    ids = set()
    for _ in range(2):
        db.execute(
            "select upsert_journal_with_lines(%s, '2026-10-01', 'expense', 'x', "
            "'financial_transaction', %s, 'posted', '{}', %s)",
            (entity, source, lines),
        )
        ids.add(db.fetchone()[0])
    assert len(ids) == 1


def test_a_locked_period_refuses_a_posted_journal(db):
    a, b = _accounts(db)
    entity = _entity(db)
    db.execute(
        "insert into accounting_period_locks (entity_id, locked_through, reason) "
        "values (%s, %s, 'test')",
        (entity, date(2026, 6, 30)),
    )
    with pytest.raises(psycopg2.Error, match="Accounting period is locked"):
        _upsert(db, entity, [(a, 10, 0), (b, 0, 10)], on="2026-06-15")


def test_a_locked_period_still_takes_a_draft(db):
    a, b = _accounts(db)
    entity = _entity(db)
    db.execute(
        "insert into accounting_period_locks (entity_id, locked_through, reason) "
        "values (%s, %s, 'test')",
        (entity, date(2026, 6, 30)),
    )
    _upsert(db, entity, [(a, 10, 0), (b, 0, 10)], status="draft", on="2026-06-15")


# ── Health checks ────────────────────────────────────────────────────────────────


def _health(cur) -> Dict[str, Dict[str, Any]]:
    cur.execute(
        "select check_name, severity, item_count, amount from accounting_health_checks"
    )
    return {
        r[0]: {"severity": r[1], "item_count": r[2], "amount": r[3]}
        for r in cur.fetchall()
    }


def test_the_ledger_checks_are_part_of_the_health_checks(db):
    names = set(_health(db))
    assert {
        "journals_balanced",
        "inventory_gl_reconciled",
        "journals_balanced_exactly",
        "excluded_transactions_unposted",
        "uncategorised_expenses",
        "cash_ties_to_bank",
    } <= names


def test_excluding_a_journaled_transaction_is_reported(db):
    db.execute(
        "select f.id from financial_transactions f join journals j on j.source_id = f.id "
        "where j.source_type = 'financial_transaction' and j.status = 'posted' "
        "and f.excluded_reason is null limit 1"
    )
    row = db.fetchone()
    if row is None:
        pytest.skip("no journaled transaction in the local seed")
    before = _health(db)["excluded_transactions_unposted"]["item_count"]
    db.execute(
        "update financial_transactions set excluded_reason = 'test', status = 'excluded' "
        "where id = %s",
        (row[0],),
    )
    after = _health(db)["excluded_transactions_unposted"]
    assert after["item_count"] == before + 1
    assert after["severity"] == "fail"


def test_a_penny_out_journal_is_reported(db):
    a, b = _accounts(db)
    before = _health(db)["journals_balanced_exactly"]["item_count"]
    _upsert(db, _entity(db), [(a, 70.94, 0), (b, 0, 70.95)])
    after = _health(db)["journals_balanced_exactly"]
    assert after["item_count"] == before + 1
    assert after["severity"] == "warn"


def _cash_business(cur, ledger: float, bank: float) -> str:
    """A new business with `ledger` posted to Revolut GBP (1014) and `bank` in its account."""
    cur.execute("insert into entities (name) values ('Tie test') returning id")
    entity = str(cur.fetchone()[0])
    cur.execute(
        "select id from chart_of_accounts where account_number = '1014' limit 1"
    )
    row = cur.fetchone()
    if row is None:  # the e2e seed's chart books bank money to 1010
        cur.execute(
            "insert into chart_of_accounts (name, account_type, account_number) "
            "values ('Revolut GBP Account', 'asset', '1014') returning id"
        )
        row = cur.fetchone()
    other = _new_account(cur)
    _upsert(cur, entity, [(str(row[0]), ledger, 0), (other, 0, ledger)])
    cur.execute(
        "insert into bank_accounts (entity_id, source, external_account_id, name, currency, "
        "balance) values (%s, 'revolut', %s, 'Main', 'GBP', %s)",
        (entity, uuid.uuid4().hex, bank),
    )
    return entity


def _cash_detail(cur) -> str:
    cur.execute(
        "select detail from ledger_health_checks where check_name = 'cash_ties_to_bank'"
    )
    detail: str = cur.fetchone()[0]
    return detail


def test_cash_that_ties_to_the_bank_has_nothing_unexplained(db):
    _cash_business(db, ledger=500, bank=500)
    assert (
        "GBP: bank 500.00, ledger 500.00, not yet posted 0.00, unexplained 0.00"
        in _cash_detail(db)
    )


def test_a_transaction_not_yet_posted_is_allowed_for(db):
    entity = _cash_business(db, ledger=500, bank=460)
    db.execute(
        "insert into financial_transactions (entity_id, source, external_transaction_id, "
        "transaction_type, direction, occurred_at, amount, currency_code, base_amount) "
        "values (%s, 'revolut', %s, 'payment', 'out', now(), 40, 'GBP', 40)",
        (entity, uuid.uuid4().hex),
    )
    assert (
        "GBP: bank 460.00, ledger 500.00, not yet posted -40.00, unexplained 0.00"
        in _cash_detail(db)
    )


def test_cash_that_does_not_tie_fails(db):
    _cash_business(db, ledger=500, bank=411.41)
    assert "unexplained -88.59" in _cash_detail(db)
    assert _health(db)["cash_ties_to_bank"]["severity"] == "fail"
