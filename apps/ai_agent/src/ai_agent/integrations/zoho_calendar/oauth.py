"""Zoho OAuth2 helpers: authorize-URL construction, code<->token exchange,
and a signed `state` parameter tying a callback back to the entity_id that
initiated it.

Unlike Shopify/PayPal's client-credentials grant (no user consent, each
user brings their own custom-app secret), Zoho Calendar requires genuine
3-legged, user-consent OAuth — there's no credentials-only path to a
specific person's own calendar. These endpoints (/oauth/v2/auth,
/oauth/v2/token, /oauth/v2/token/revoke) are Zoho's standard
platform-wide OAuth2 endpoints, not Calendar-specific, so they're on solid
documented ground.

The integrations router has no request auth today (entity_id is
client-supplied) — that's a pre-existing gap elsewhere, but here it would
let anyone attach their own Zoho account to someone else's entity_id
mid-flow if `state` were a bare, unsigned value. Signing it closes that off
without needing to add auth to routes this module doesn't own.
"""

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from typing import Any, Dict
from urllib.parse import urlencode

import httpx

from ...core.config import settings

logger = logging.getLogger(__name__)

STATE_TTL_SECONDS = 600  # 10 minutes

# Read+write on both calendars and events: the pull direction reads events,
# the push direction creates/patches events in a calendar it also has to be
# able to create (the "ThreadWise Deadlines" calendar).
SCOPE = "ZohoCalendar.calendar.ALL,ZohoCalendar.event.ALL"


class ZohoOAuthError(Exception):
    """Raised for any failure in the Zoho OAuth2 flow — bad/expired code,
    a revoked refresh token, or an unusable response. Zoho returns HTTP 200
    with an error body for these (see _post_token) rather than a non-2xx
    status, so this — not an httpx.HTTPStatusError — is what callers should
    actually catch.
    """


def _state_secret() -> bytes:
    # Reuses the app's own OAuth client secret as the HMAC key rather than
    # introduce a fifth env var just for this — it's already a secret only
    # this backend holds, and unlike client_secret it's never transmitted
    # anywhere as part of the flow (client_secret is, in the token exchange
    # body). If client_secret were ever compromised, state-signing being
    # compromised too is the least of the resulting problems.
    return settings.zoho_client_secret.encode("utf-8")


def mint_state(entity_id: str) -> str:
    """Build a signed, expiring state value carrying `entity_id`."""
    payload = {
        "entity_id": entity_id,
        "nonce": secrets.token_urlsafe(12),
        "exp": int(time.time()) + STATE_TTL_SECONDS,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8"))
    payload_b64 = encoded.decode("ascii").rstrip("=")
    signature = hmac.new(
        _state_secret(), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()
    return f"{payload_b64}.{signature}"


def verify_state(state: str) -> str:
    """Verify a signed state value and return its entity_id.

    Raises:
        ZohoOAuthError: the value is malformed, the signature doesn't
            match, or it has expired.
    """
    try:
        payload_b64, signature = state.split(".", 1)
    except ValueError as e:
        raise ZohoOAuthError("Malformed state parameter") from e

    expected = hmac.new(
        _state_secret(), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ZohoOAuthError("Invalid state signature")

    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded))
    except Exception as e:
        raise ZohoOAuthError(f"Malformed state payload: {e}") from e

    if payload.get("exp", 0) < time.time():
        raise ZohoOAuthError("State has expired — please try connecting again")

    entity_id = payload.get("entity_id")
    if not entity_id:
        raise ZohoOAuthError("State payload missing entity_id")

    return entity_id


def build_authorize_url(entity_id: str) -> str:
    """Build the Zoho consent-screen URL for a given entity.

    access_type=offline and prompt=consent are both required to actually
    get a refresh_token back — omitting either means a reconnect of an
    already-authorized account silently returns none, leaving a broken
    connection with no way to sync.
    """
    params = {
        "response_type": "code",
        "client_id": settings.zoho_client_id,
        "scope": SCOPE,
        "redirect_uri": settings.zoho_redirect_uri,
        "access_type": "offline",
        "prompt": "consent",
        "state": mint_state(entity_id),
    }
    return f"https://{settings.zoho_accounts_domain}/oauth/v2/auth?{urlencode(params)}"


async def _post_token(data: Dict[str, str]) -> Dict[str, Any]:
    """POST to Zoho's token endpoint and raise ZohoOAuthError on any
    reported failure.

    Zoho returns HTTP 200 with an error body (e.g. {"error":"invalid_code"})
    on a bad/expired code or a revoked refresh token — response.raise_for_
    status() would sail straight past this, so the body is inspected
    explicitly instead.
    """
    url = f"https://{settings.zoho_accounts_domain}/oauth/v2/token"
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(url, data=data)

    try:
        payload = response.json()
    except ValueError as e:
        raise ZohoOAuthError(
            "Zoho token endpoint returned a non-JSON response "
            f"(HTTP {response.status_code})"
        ) from e

    if "error" in payload:
        raise ZohoOAuthError(f"Zoho token request failed: {payload['error']}")

    return payload


async def exchange_code_for_tokens(code: str) -> Dict[str, Any]:
    """Exchange an authorization code for access + refresh tokens.

    Raises:
        ZohoOAuthError: Zoho reported an error, or no refresh_token came
            back (meaning access_type=offline/prompt=consent weren't
            honored — most commonly a re-consent Zoho didn't treat as
            fresh).
    """
    data = await _post_token(
        {
            "grant_type": "authorization_code",
            "client_id": settings.zoho_client_id,
            "client_secret": settings.zoho_client_secret,
            "redirect_uri": settings.zoho_redirect_uri,
            "code": code,
        }
    )
    if not data.get("refresh_token"):
        raise ZohoOAuthError(
            "Zoho did not return a refresh token. This usually means the "
            "account was already connected and re-consent wasn't forced — "
            "disconnect any existing Zoho connection for this account and "
            "try again."
        )
    return data


async def refresh_access_token(refresh_token: str) -> Dict[str, Any]:
    """Exchange a refresh token for a new access token.

    Raises:
        ZohoOAuthError: the refresh token has been revoked or expired.
    """
    data = await _post_token(
        {
            "grant_type": "refresh_token",
            "client_id": settings.zoho_client_id,
            "client_secret": settings.zoho_client_secret,
            "refresh_token": refresh_token,
        }
    )
    if not data.get("access_token"):
        raise ZohoOAuthError("Zoho refresh response was missing an access_token")
    return data


async def revoke_refresh_token(refresh_token: str) -> None:
    """Best-effort revoke of a refresh token.

    Called from the disconnect path — Zoho caps refresh tokens at 20 per
    client per user and silently evicts the oldest, so repeated
    connect/disconnect cycles during development or re-auth will otherwise
    break other connections. Failures are logged, not raised: disconnecting
    the source in our own database should still succeed even if Zoho's
    revoke call fails.
    """
    url = f"https://{settings.zoho_accounts_domain}/oauth/v2/token/revoke"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, params={"token": refresh_token})
            if response.status_code >= 400:
                logger.warning(
                    "Zoho token revoke returned HTTP %s: %s",
                    response.status_code,
                    response.text,
                )
    except Exception as e:
        logger.warning("Failed to revoke Zoho refresh token: %s", e)
