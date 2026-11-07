"""Whether a connected source's key still works, asked of the provider itself.

Each check makes the smallest request the provider allows with the stored key and answers
with `(ok, message)`:

- `True`: the provider accepted the key.
- `False`: the provider refused it (401/403, an unknown shop, a revoked Zoho token, a key
  that is missing or malformed). The connection needs the user.
- `None`: no answer either way (a timeout, a 5xx, a rate limit). Nothing is known, so the
  daily check (`services/integration_checks.py`) neither raises nor clears a notification
  on it. The Check key button treats it as not working, as it always has.

The Integrations page's Check key button (`POST /integrations/sources/{id}/validate`) and
the daily check both use these.
"""

import json
import logging
import os
from typing import Any, Dict, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

Check = Tuple[Optional[bool], Optional[str]]

TIMEOUT = 10.0
USER_AGENT = "ThreadWise/1.0"
TIMED_OUT = "Request timed out - check your network connection"

# Zoho's own error codes that mean the refresh token no longer works. Any other error (Zoho
# answers "Access Denied" when it is rate limiting) says nothing about the connection.
ZOHO_REFUSALS = {
    "invalid_code",
    "invalid_client",
    "invalid_token",
    "unauthorized_client",
}


def _unexpected(provider: str, status: int) -> Check:
    return None, f"{provider} API returned status {status}"


async def check_squarespace(api_key: str) -> Check:
    """Squarespace: list one inventory item."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://api.squarespace.com/1.0/commerce/inventory",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": USER_AGENT,
                },
                params={"limit": 1},
                timeout=TIMEOUT,
            )
        if response.status_code == 200:
            return True, None
        if response.status_code == 401:
            return False, "Invalid API key - authentication failed"
        if response.status_code == 403:
            return False, "API key lacks required permissions"
        return _unexpected("Squarespace", response.status_code)
    except httpx.TimeoutException:
        return None, TIMED_OUT
    except Exception as e:
        return None, f"Connection error: {str(e)}"


async def check_revolut(api_key: str, source_id: Optional[str] = None) -> Check:
    """Revolut Business: list the accounts.

    A key that is a Revolut sign-in (integrations/revolut/oauth.py) first mints an access token
    from its refresh token; a refused refresh means the user has to reconnect.
    """
    from ..integrations.revolut.oauth import (
        RevolutOAuthError,
        access_token_for,
        parse_credentials,
        store_rotated_for,
    )

    creds = parse_credentials(api_key)
    token = api_key
    if creds:
        try:
            token = await access_token_for(creds, store_rotated_for(source_id))
        except RevolutOAuthError as e:
            if e.refused:
                return False, (
                    "Revolut sign-in has expired or was revoked - reconnect with Revolut"
                )
            return None, f"Revolut sign-in could not be renewed: {e}"
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://b2b.revolut.com/api/1.0/accounts",
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": USER_AGENT,
                },
                timeout=TIMEOUT,
            )
        if response.status_code == 200:
            return True, None
        if response.status_code == 401:
            if creds:
                return False, "Revolut refused the sign-in - reconnect with Revolut"
            return False, (
                "Invalid API key - authentication failed. Pasted tokens expire after "
                "about 40 minutes: connect with Revolut so it renews itself"
            )
        if response.status_code == 403:
            return False, "API key lacks required permissions"
        return _unexpected("Revolut", response.status_code)
    except httpx.TimeoutException:
        return None, TIMED_OUT
    except Exception as e:
        return None, f"Connection error: {str(e)}"


async def check_revolut_merchant(api_key: str) -> Check:
    """Revolut Merchant secret key: list one order."""
    from ..integrations.revolut.merchant import API_VERSION, MERCHANT_BASE_URL

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{MERCHANT_BASE_URL}/api/orders",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Revolut-Api-Version": API_VERSION,
                    "User-Agent": USER_AGENT,
                },
                params={"limit": 1},
                timeout=TIMEOUT,
            )
        if response.status_code == 200:
            return True, None
        if response.status_code == 401:
            return False, (
                "Invalid key - use the Production secret key from "
                "Merchant, APIs in Revolut Business"
            )
        if response.status_code == 403:
            return False, "Key lacks access to orders"
        return _unexpected("Revolut Merchant", response.status_code)
    except httpx.TimeoutException:
        return None, TIMED_OUT
    except Exception as e:
        return None, f"Connection error: {str(e)}"


async def check_paypal(api_key: str) -> Check:
    """PayPal: exchange the client id and secret for a token.

    The key is JSON: {"client_id": "...", "secret": "..."}.
    """
    try:
        creds = json.loads(api_key)
    except json.JSONDecodeError:
        return (
            False,
            'PayPal credentials must be valid JSON: {"client_id":"...","secret":"..."}',
        )
    client_id = creds.get("client_id")
    secret = creds.get("secret")
    if not client_id or not secret:
        return False, "PayPal credentials must include 'client_id' and 'secret'"

    base_url = os.environ.get("PAYPAL_API_URL", "https://api-m.paypal.com")
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{base_url}/v1/oauth2/token",
                auth=(client_id, secret),
                data={"grant_type": "client_credentials"},
                headers={"Accept": "application/json"},
                timeout=TIMEOUT,
            )
        if response.status_code == 200:
            return True, None
        if response.status_code in (400, 401, 403):
            return False, "Invalid client_id or secret - authentication failed"
        return _unexpected("PayPal", response.status_code)
    except httpx.TimeoutException:
        return None, TIMED_OUT
    except Exception as e:
        return None, f"Connection error: {str(e)}"


async def check_shopify(api_key: str, shop_domain: str) -> Check:
    """Shopify: the client credentials grant for the shop.

    The key is JSON: {"client_id": "...", "client_secret": "..."}.
    """
    if not shop_domain:
        return (
            False,
            "Shop domain is required - set it as the Account ID when creating the source",
        )
    try:
        creds = json.loads(api_key)
    except json.JSONDecodeError:
        return (
            False,
            'Credentials must be valid JSON: {"client_id":"...","client_secret":"..."}',
        )
    client_id = creds.get("client_id")
    client_secret = creds.get("client_secret")
    if not client_id or not client_secret:
        return (
            False,
            "Shopify credentials must include 'client_id' and 'client_secret'",
        )

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"https://{shop_domain}/admin/oauth/access_token",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
            )
        if resp.status_code == 200:
            return True, None
        if resp.status_code in (400, 401, 403):
            # Shopify answers 400 invalid_client for a secret it no longer accepts (the
            # app was uninstalled or its secret rotated) and 401 for a wrong one.
            return False, "Invalid client_id or client_secret - authentication failed"
        if resp.status_code == 404:
            return False, f"Shop not found: {shop_domain}"
        logger.error(
            f"Shopify API validation failed with status {resp.status_code}: {resp.text}"
        )
        return _unexpected("Shopify", resp.status_code)
    except httpx.TimeoutException:
        return None, TIMED_OUT
    except Exception as e:
        return None, f"Connection error: {str(e)}"


async def check_zoho_calendar(api_key: str) -> Check:
    """Zoho Calendar: refresh the access token with the stored refresh token.

    The key is JSON: {"refresh_token": "...", "api_domain": "..."}, from the OAuth flow in
    integrations/zoho_calendar/oauth.py.
    """
    from ..integrations.zoho_calendar.oauth import ZohoOAuthError, refresh_access_token

    try:
        creds = json.loads(api_key)
    except json.JSONDecodeError:
        return False, "Zoho Calendar credentials are corrupted (not valid JSON)"
    refresh_token = creds.get("refresh_token")
    if not refresh_token:
        return False, "Zoho Calendar credentials are missing a refresh_token"

    try:
        await refresh_access_token(refresh_token)
        return True, None
    except ZohoOAuthError as e:
        refused = e.code in ZOHO_REFUSALS
        return (False if refused else None), f"Zoho Calendar token refresh failed: {e}"
    except Exception as e:
        return None, f"Connection error: {str(e)}"


async def check_source(source: Dict[str, Any], api_key: Optional[str]) -> Check:
    """Check one `external_sources` row with its key (from the Vault)."""
    if not api_key:
        return False, "No API key configured"
    provider = source.get("provider")
    if provider == "squarespace":
        return await check_squarespace(api_key)
    if provider == "revolut":
        return await check_revolut(api_key, source.get("id"))
    if provider == "revolut_merchant":
        return await check_revolut_merchant(api_key)
    if provider == "paypal":
        return await check_paypal(api_key)
    if provider == "shopify":
        return await check_shopify(api_key, source.get("external_account_id") or "")
    if provider == "zoho_calendar":
        return await check_zoho_calendar(api_key)
    return None, f"Unknown provider: {provider}"
