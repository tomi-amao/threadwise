"""OAuth2 routes for providers that need real user-consent authorization
rather than the manually-entered credentials every other integration uses.

Backend-driven by design: the frontend's "Connect" affordance is a plain
link to /oauth/{provider}/start, and never needs to know a provider's
client_id, scopes, or authorize-URL shape. Currently Zoho Calendar only —
if a second OAuth provider is ever added, its routes belong here too rather
than each provider inventing its own module.
"""

import json
import logging
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse

from ...core.config import settings
from ...integrations.zoho_calendar import ZohoCalendarAdapter
from ...integrations.zoho_calendar.oauth import (
    ZohoOAuthError,
    build_authorize_url,
    exchange_code_for_tokens,
    verify_state,
)
from ...services.external_sync_service import sync_service
from ..deps import CurrentUser, current_user

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
