"""OAuth2 routes for providers that need real user-consent authorization
rather than the manually-entered credentials every other integration uses.

Backend-driven by design: the frontend never needs to know a provider's scopes
or authorize-URL shape. Zoho Calendar and Revolut Business.

The two differ in where the browser comes back. Zoho redirects to this backend's own public
callback, which trusts the signed `state` alone. Revolut redirects to the app
(`/api/integrations/revolut/callback`), which holds the user's session: it checks the state
against a cookie set when the flow started and then calls `POST /oauth/revolut/exchange` as
the signed-in user, so every Revolut route here requires a user token, and the business in the
state must be the caller's.
"""

import json
import logging
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, Field

from ...core.config import settings
from ...integrations.revolut import oauth as revolut_oauth
from ...integrations.zoho_calendar import ZohoCalendarAdapter
from ...integrations.zoho_calendar.oauth import (
    ZohoOAuthError,
    build_authorize_url,
    exchange_code_for_tokens,
    verify_state,
)
from ...services.external_sync_service import sync_service
from ..deps import CurrentUser, assert_owned, current_user

logger = logging.getLogger(__name__)

router = APIRouter()

# Where the browser lands after the callback finishes, success or failure —
# the frontend integrations page reads ?zoho_calendar= to show a toast. This
# backend has no other reason to know the frontend's origin (CORS is wide
# open here, not origin-specific), but a server-issued redirect needs an
# absolute URL: the browser is on *this* backend's own origin when the
# redirect fires, so a bare path would resolve against the wrong host.
_INTEGRATIONS_PAGE_PATH = "/integrations"


def _redirect_to_integrations(zoho_calendar: str, reason: str = "") -> RedirectResponse:
    params = {"zoho_calendar": zoho_calendar}
    if reason:
        params["reason"] = reason
    return RedirectResponse(
        f"{settings.frontend_url}{_INTEGRATIONS_PAGE_PATH}?{urlencode(params)}"
    )


@router.get("/zoho_calendar/authorize-url", dependencies=[Depends(current_user)])
async def zoho_calendar_authorize_url(user: CurrentUser):
    """The Zoho consent-screen URL for the caller's own business.

    The browser cannot send an Authorization header on a plain link or redirect, so the
    frontend asks for this URL (signed in) and then navigates to it. The business comes from
    the verified token, never from the request, and is what the signed `state` carries into
    the callback below (the callback is public: Zoho redirects the browser to it).
    """
    if not settings.zoho_client_id or not settings.zoho_client_secret:
        raise HTTPException(
            status_code=500,
            detail=(
                "Zoho Calendar is not configured on this server - "
                "ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET are unset."
            ),
        )
    assert user.entity_id is not None
    return {"url": build_authorize_url(user.entity_id)}


@router.get("/zoho_calendar/callback")
async def zoho_calendar_oauth_callback(
    code: str = Query(None),
    state: str = Query(None),
    error: str = Query(None),
):
    """Exchange the authorization code, create the external_sources row,
    and create the dedicated "ThreadWise Deadlines" calendar.

    Doing the deadlines-calendar creation here — at connection time, not
    later when the push direction first runs — is what lets the pull sync
    (built in a later phase) exclude it correctly from day one, with no
    window where a not-yet-created calendar could be missed.
    """
    if error:
        # The user declined consent, or Zoho reported a setup problem before
        # any code was even issued.
        return _redirect_to_integrations("error", reason=error)
    if not code or not state:
        return _redirect_to_integrations("error", reason="missing_code_or_state")

    try:
        entity_id = verify_state(state)
    except ZohoOAuthError as e:
        logger.warning("Zoho OAuth callback rejected: %s", e)
        return _redirect_to_integrations("error", reason="invalid_state")

    try:
        tokens = await exchange_code_for_tokens(code)
    except ZohoOAuthError as e:
        logger.error("Zoho token exchange failed: %s", e)
        return _redirect_to_integrations("error", reason="token_exchange_failed")

    credentials_json_str = _build_credentials_json(tokens)

    # Create-or-find the deadlines calendar before the source is persisted,
    # so a failure here doesn't leave a connection that looks "valid" but
    # is actually missing the piece the push direction depends on.
    adapter = ZohoCalendarAdapter(credentials_json_str, settings.zoho_accounts_domain)
    try:
        deadlines_calendar_uid = await adapter.get_or_create_deadlines_calendar()
    except Exception as e:
        logger.error("Failed to create ThreadWise Deadlines calendar: %s", e)
        return _redirect_to_integrations("error", reason="calendar_setup_failed")

    try:
        source = await sync_service.create_external_source(
            entity_id=entity_id,
            provider="zoho_calendar",
            # The deadlines calendar's UID doubles as the account identifier
            # — every other provider uses external_account_id for "the one
            # thing on the far end this connection is about" (Shopify's shop
            # domain, Squarespace's site ID); for this provider that's the
            # calendar ThreadWise writes to, since the pull direction reads
            # from potentially many calendars but only ever writes to one.
            external_account_id=deadlines_calendar_uid,
            credentials={"api_key": credentials_json_str},
            display_name="Zoho Calendar",
        )
    except Exception as e:
        logger.error("Failed to create external_sources row for Zoho Calendar: %s", e)
        return _redirect_to_integrations("error", reason="source_creation_failed")

    if source is None:
        logger.error("Zoho Calendar external_sources row was not created")
        return _redirect_to_integrations("error", reason="source_creation_failed")

    await sync_service.update_api_key_status(source["id"], "valid")

    return _redirect_to_integrations("connected")


def _build_credentials_json(tokens: dict) -> str:
    """Build the JSON blob stored as this source's Vault-encrypted api_key.

    Mirrors how Shopify/PayPal already store a JSON object there
    ({"client_id":..., "client_secret":...}) — same storage mechanism, just
    a different shape of secret.
    """
    return json.dumps(
        {
            "refresh_token": tokens["refresh_token"],
            "api_domain": tokens.get("api_domain"),
        }
    )


# =============================================================================
# Revolut Business
# =============================================================================


class RevolutConnectRequest(BaseModel):
    """Start a Revolut sign-in: for an existing Revolut integration, or a new one."""

    # Revolut's client ID for this business. Optional to reconnect an integration already signed
    # in: the one stored with it is used.
    client_id: Optional[str] = Field(None, max_length=200)
    # Upgrade this Revolut integration in place (its synced data stays). Omit for a new one.
    source_id: Optional[str] = Field(None, max_length=64)
    # A new integration only: the business ID and an optional name, as for any provider.
    external_account_id: Optional[str] = Field(None, max_length=200)
    display_name: Optional[str] = Field(None, max_length=200)


class RevolutExchangeRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=2048)
    state: str = Field(..., min_length=1, max_length=4096)


def _revolut_error(code: int, reason: str, message: str) -> HTTPException:
    # `reason` is a short code the app puts in its redirect; `message` is for people.
    return HTTPException(
        status_code=code, detail={"reason": reason, "message": message}
    )


def _require_revolut_configured() -> None:
    if not revolut_oauth.configured():
        raise _revolut_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "not_configured",
            "Revolut sign-in is not set up on this server (REVOLUT_PRIVATE_KEY is unset).",
        )


async def _owned_revolut_source(user: CurrentUser, source_id: str) -> Dict[str, Any]:
    """The caller's own Revolut integration, or 404 (missing and not-yours look the same)."""
    await assert_owned(user, "external_sources", source_id)
    source = await sync_service.get_external_source(source_id)
    if not source or source.get("provider") != "revolut":
        raise _revolut_error(
            status.HTTP_404_NOT_FOUND,
            "not_found",
            "That Revolut integration was not found.",
        )
    return source


@router.get("/revolut/setup", dependencies=[Depends(current_user)])
async def revolut_setup():
    """What a business needs to set up the sign-in in Revolut: is it offered, and the redirect URI."""
    if not revolut_oauth.configured():
        return {"configured": False, "redirect_uri": None}
    return {"configured": True, "redirect_uri": revolut_oauth.redirect_uri()}


@router.get("/revolut/certificate", dependencies=[Depends(current_user)])
async def revolut_certificate():
    """The public certificate to upload in Revolut Business (Settings, APIs, Business API)."""
    _require_revolut_configured()
    try:
        pem = revolut_oauth.certificate_pem()
    except revolut_oauth.RevolutOAuthError as e:
        logger.error("Revolut certificate unavailable: %s", e)
        raise _revolut_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "not_configured", str(e)
        ) from e
    return Response(
        content=pem,
        media_type="application/x-pem-file",
        headers={
            "Content-Disposition": 'attachment; filename="threadwise-revolut.cer"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/revolut/authorize-url", dependencies=[Depends(current_user)])
async def revolut_authorize_url(body: RevolutConnectRequest, user: CurrentUser):
    """Revolut's consent URL for the caller's business, and the signed state it carries.

    The business comes from the token. The state also names the integration being upgraded
    (checked to be the caller's here, and again at the exchange) and the client ID, so nothing
    the browser sends back later can change which business or connection it is for.
    """
    _require_revolut_configured()
    client_id = (body.client_id or "").strip()
    if body.source_id:
        await _owned_revolut_source(user, body.source_id)
        if not client_id:
            stored = await sync_service.get_api_key(body.source_id)
            creds = revolut_oauth.parse_credentials(stored or "")
            client_id = creds["client_id"] if creds else ""
    if not revolut_oauth.valid_client_id(client_id):
        raise _revolut_error(
            status.HTTP_400_BAD_REQUEST,
            "invalid_client_id",
            "That does not look like a Revolut client ID. Copy it from Revolut Business, "
            "Settings, APIs, Business API.",
        )
    if not body.source_id and not (body.external_account_id or "").strip():
        raise _revolut_error(
            status.HTTP_400_BAD_REQUEST,
            "missing_account",
            "Give the Revolut business ID for a new integration.",
        )

    assert user.entity_id is not None
    state = revolut_oauth.mint_state(
        {
            "entity_id": user.entity_id,
            "client_id": client_id,
            "source_id": body.source_id,
            "external_account_id": (body.external_account_id or "").strip() or None,
            "display_name": (body.display_name or "").strip() or None,
        }
    )
    return {"url": revolut_oauth.build_authorize_url(client_id, state), "state": state}


async def _can_read_accounts(access_token: str) -> bool:
    """Whether the new token can read the business's accounts (proves the consent worked)."""
    try:
        async with httpx.AsyncClient(timeout=revolut_oauth.TIMEOUT) as client:
            response = await client.get(
                revolut_oauth.ACCOUNTS_URL,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "User-Agent": revolut_oauth.USER_AGENT,
                },
            )
    except httpx.HTTPError as e:
        logger.warning("Revolut accounts check failed: %s", e)
        return False
    return response.status_code == 200


@router.post("/revolut/exchange", dependencies=[Depends(current_user)])
async def revolut_exchange(body: RevolutExchangeRequest, user: CurrentUser):
    """Finish a Revolut sign-in: exchange the code and store the connection.

    An existing integration is upgraded in place (its key replaced, its data kept); otherwise a
    new one is created. Only the client ID and the refresh token are stored, in the Vault.
    """
    _require_revolut_configured()
    try:
        claims = revolut_oauth.verify_state(body.state)
    except revolut_oauth.RevolutOAuthError as e:
        logger.warning("Revolut sign-in refused: %s", e)
        raise _revolut_error(
            status.HTTP_400_BAD_REQUEST, "invalid_state", str(e)
        ) from e

    assert user.entity_id is not None
    if str(claims["entity_id"]).lower() != user.entity_id.lower():
        # A state minted for another business: someone else's sign-in in this browser.
        logger.warning("Revolut sign-in state belongs to another business")
        raise _revolut_error(
            status.HTTP_403_FORBIDDEN,
            "wrong_business",
            "This sign-in was started for a different business.",
        )

    client_id = str(claims["client_id"])
    source_id = claims.get("source_id")
    if source_id:
        await _owned_revolut_source(user, str(source_id))

    try:
        tokens = await revolut_oauth.exchange_code(body.code, client_id)
    except revolut_oauth.RevolutOAuthError as e:
        logger.warning("Revolut code exchange failed: %s", e)
        raise _revolut_error(
            status.HTTP_400_BAD_REQUEST,
            "token_exchange_failed",
            "Revolut did not accept the sign-in. Check that the certificate and redirect "
            "URI are saved in Revolut for this client ID, then try again.",
        ) from e

    if not await _can_read_accounts(str(tokens["access_token"])):
        raise _revolut_error(
            status.HTTP_400_BAD_REQUEST,
            "no_access",
            "Revolut signed in, but the accounts could not be read with it.",
        )

    refresh_token = str(tokens["refresh_token"])
    credentials = revolut_oauth.credentials_json(client_id, refresh_token)
    if source_id:
        saved = await sync_service.update_api_key(str(source_id), credentials)
        if saved is False:
            raise _revolut_error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "save_failed",
                "The Revolut sign-in could not be saved.",
            )
        result_id = str(source_id)
    else:
        source = await sync_service.create_external_source(
            entity_id=user.entity_id,
            provider="revolut",
            external_account_id=str(claims.get("external_account_id") or ""),
            credentials={"api_key": credentials},
            display_name=claims.get("display_name"),
        )
        if not source:
            raise _revolut_error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "save_failed",
                "The Revolut integration could not be created.",
            )
        result_id = str(source["id"])

    await sync_service.set_auth_method(result_id, "oauth")
    await sync_service.update_api_key_status(result_id, "valid")
    revolut_oauth.remember_access_token(client_id, refresh_token, tokens)
    return {"status": "connected", "source_id": result_id, "upgraded": bool(source_id)}
