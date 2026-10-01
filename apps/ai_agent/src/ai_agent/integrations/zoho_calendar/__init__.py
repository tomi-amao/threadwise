"""Zoho Calendar API adapter for ThreadWise.

Authenticates via OAuth 2.0 refresh-token grant (see this package's
oauth.py for the initial 3-legged consent flow) rather than the
client-credentials grant Shopify/PayPal use — there's no credentials-only
path to a specific person's own calendar.

Endpoint paths below are graded by confidence, not all equally certain:

  CONFIRMED (from Zoho's own Calendar API docs, fetched directly, and the
  calendars-list + create-calendar paths additionally confirmed live
  against a real Zoho account on the .eu data center during Phase 2):
    - Base URL shape:   https://calendar.zoho.com/api/v1 (also verified on
      the .eu data center — calendar.zoho.<tld> is real, not just a .com
      assumption)
    - Calendars list:   GET  {base}/calendars — response has a top-level
      "calendars" array.
    - Create calendar:  POST {base}/calendars — NOT a JSON body. Takes a
      single query param, "calendarData", whose value is the JSON payload
      as a string; "name" and "color" (hex, #RRGGBB) are both mandatory —
      omitting "color" is what a live LESS_THAN_MIN_OCCURANCE error caught.
      Response is {"calendars": [{"uid": ..., ...}]} (array, not singular).
    - Events list:      GET  {base}/calendars/{calendarUid}/events — also
      query-param-JSON, not a JSON body: a mandatory "range" param whose
      value is a JSON string {"start": ..., "end": ...} in "yyyyMMdd" or
      "yyyyMMdd'T'HHmmss'Z'" format, and a single request's range cannot
      exceed 31 days (Zoho-enforced — see EVENT_RANGE_MAX_DAYS below).
      Response has a top-level "events" array; no pagination parameter is
      documented, so one request per <=31-day slice is assumed to return
      everything in that slice. The docs describe top-level "start"/"end"
      fields on each event, but two real events fetched live (one timed,
      one all-day) had neither — only a nested "dateandtime" object, whose
      own format differs by event type (all-day: bare "yyyyMMdd"; timed:
      "yyyyMMdd'T'HHmmss+HHMM" with an explicit UTC offset, not "Z"). See
      _parse_zoho_event_datetime below.
    - Create event: POST {base}/calendars/{calendarUid}/events — query
      param "eventdata" (JSON string), not a JSON body. Required keys:
      "title", "dateandtime" ({"start", "end"}, format
      "yyyyMMdd'T'HHmmss'Z'" for timed or "yyyyMMdd" for all-day — note
      this is the opposite of what GET returns for an existing event,
      which uses a local UTC offset rather than "Z"). Response is
      {"events": [{"uid": ..., ...}]}.
    - Patch event:  PUT  {base}/calendars/{calendarUid}/events/{eventUid}
      — same "eventdata" query param; full-replace semantics, not a
      partial patch. Response shape matches create.

  Create event (title/dateandtime/isallday/description) is additionally
  confirmed live during Phase 5 — pushed 13 real tax-deadline and
  collection-launch events, then read them back via the events-list
  endpoint and verified titles/dates. update_event (PUT) and the
  "location" field are still docs-only, not yet exercised live.

The regional host (calendar.zoho.<tld>) is derived from settings.
zoho_accounts_domain's own TLD rather than the `api_domain` field Zoho's
OAuth token response returns — that field is genuine, documented Zoho OAuth
behavior, but it's a platform-wide mechanism (used by e.g. CRM/Books, which
are served from the generic www.zohoapis.<region> gateway) and this
codebase has not been able to confirm whether Calendar's API is ever
actually served from that gateway for any region, versus always living on
its own calendar.zoho.<tld> host as the docs state. api_domain is still
captured and stored per-connection since it's real data worth keeping, but
the calendar host is computed independently until this is verified.
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..common import RawEventRecord
from .oauth import ZohoOAuthError, refresh_access_token

__all__ = ["ZohoCalendarAdapter", "ZohoAuthError", "DEADLINES_CALENDAR_NAME"]

logger = logging.getLogger(__name__)

# Buffer before token expiry to trigger a refresh (5 minutes) — same
# convention as ShopifyAdapter.
TOKEN_EXPIRY_BUFFER_SECONDS = 300

# Created once per connection (in the OAuth callback) and excluded from the
# pull sync, so events ThreadWise pushes here are never re-imported as if
# they were new events from the user's own calendars.
DEADLINES_CALENDAR_NAME = "ThreadWise Deadlines"

# Zoho-enforced cap on a single events-list request's date range (confirmed
# from Zoho's own docs) — wider windows must be chunked into slices this
# size or smaller.
EVENT_RANGE_MAX_DAYS = 31

# Rolling pull window applied on every sync (no incremental "since" cursor
# exists for Zoho Calendar events — see the sync functions' module
# docstring for why this is a deliberate tradeoff, not a gap).
PULL_WINDOW_PAST_DAYS = 90
PULL_WINDOW_FUTURE_DAYS = 365


class ZohoAuthError(Exception):
    """Raised when the stored refresh token is no longer valid.

    Callers (the Inngest sync functions, built in a later phase) are
    expected to mark the source invalid and raise inngest.NonRetriableError
    on this — mirroring how ShopifyAdapter's 401/403 is handled one level
    up rather than inside the adapter itself.
    """


def _raise_with_body(resp: httpx.Response) -> None:
    """Like resp.raise_for_status(), but the error message includes the
    response body — httpx's own exception message doesn't, and Zoho's error
    bodies are the only thing that will tell us which of the INFERRED
    calendar endpoints (see module docstring) is actually wrong.
    """
    if resp.status_code >= 400:
        raise httpx.HTTPStatusError(
            f"{resp.status_code} {resp.reason_phrase} for url "
            f"{resp.request.url!r} — body: {resp.text}",
            request=resp.request,
            response=resp,
        )


def _parse_zoho_event_datetime(value: Optional[str]) -> Optional[datetime]:
    """Parse a Zoho event's dateandtime.start/end value.

    Confirmed against two real events (one timed, one all-day) fetched
    live — see module docstring. All-day is a bare "yyyyMMdd" date; timed
    is "yyyyMMdd'T'HHmmss+HHMM" with an explicit UTC offset, not "Z".
    """
    if not value:
        return None
    if len(value) == 8 and value.isdigit():
        try:
            return datetime.strptime(value, "%Y%m%d").replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    for fmt in ("%Y%m%dT%H%M%S%z", "%Y%m%dT%H%M%SZ"):
        try:
            parsed = datetime.strptime(value, fmt)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    logger.debug("Unparsable Zoho event datetime: %r", value)
    return None


def _calendar_api_base(accounts_domain: str) -> str:
    """Derive the Calendar API host from the accounts domain's regional TLD.

    E.g. "accounts.zoho.com" -> "https://calendar.zoho.com/api/v1",
    "accounts.zoho.eu" -> "https://calendar.zoho.eu/api/v1".
    """
    prefix = "accounts.zoho."
    suffix = (
        accounts_domain.split(prefix, 1)[-1] if prefix in accounts_domain else "com"
    )
    return f"https://calendar.zoho.{suffix}/api/v1"


class ZohoCalendarAdapter:
    """Adapter for the Zoho Calendar REST API."""

    def __init__(
        self,
        credentials_json: str,
        accounts_domain: str,
        timeout: float = 30.0,
    ):
        """Initialize the adapter.

        Args:
            credentials_json: JSON string {"refresh_token": "...",
                "api_domain": "https://www.zohoapis.<region>"} — api_domain
                comes from Zoho's OAuth token response and is stored for
                completeness, but the Calendar API host is computed
                separately (see module docstring).
            accounts_domain: The regional accounts host this connection was
                authorized against (e.g. "accounts.zoho.eu"), used to derive
                the matching Calendar API host.
            timeout: Request timeout in seconds.
        """
        creds = json.loads(credentials_json)
        self.refresh_token: str = creds["refresh_token"]
        self.api_domain: Optional[str] = creds.get("api_domain")
        self.timeout = timeout
        self._base_url = _calendar_api_base(accounts_domain)

        # Token cache — populated lazily on first request, same pattern as
        # ShopifyAdapter.
        self._access_token: Optional[str] = None
        self._token_expires_at: Optional[datetime] = None

    # -------------------------------------------------------------------------
    # Token management
    # -------------------------------------------------------------------------

    async def _ensure_token(self) -> None:
        """Refresh the access token if missing or about to expire."""
        now = datetime.now(timezone.utc)
        if (
            self._access_token
            and self._token_expires_at
            and now < self._token_expires_at
        ):
            return

        try:
            token_data = await refresh_access_token(self.refresh_token)
        except ZohoOAuthError as e:
            raise ZohoAuthError(str(e)) from e

        self._access_token = token_data["access_token"]
        expires_in = token_data.get("expires_in", 3600)
        self._token_expires_at = now + timedelta(
            seconds=expires_in - TOKEN_EXPIRY_BUFFER_SECONDS
        )
        logger.debug(
            "Zoho Calendar access token refreshed, expires at %s",
            self._token_expires_at,
        )

    def _auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Zoho-oauthtoken {self._access_token or ''}"}

    # -------------------------------------------------------------------------
    # Calendars
    # -------------------------------------------------------------------------

    async def list_calendars(self) -> List[Dict[str, Any]]:
        """Return every calendar visible to this connection."""
        await self._ensure_token()
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.get(
                f"{self._base_url}/calendars", headers=self._auth_headers()
            )
            _raise_with_body(resp)
            return resp.json().get("calendars", [])

    async def get_or_create_deadlines_calendar(self) -> str:
        """Return the UID of the "ThreadWise Deadlines" calendar, creating
        it if it doesn't already exist.

        Idempotent — safe to call every time a connection is (re)established
        (the OAuth callback does this on every successful connect).
        """
        calendars = await self.list_calendars()
        for cal in calendars:
            if cal.get("name") == DEADLINES_CALENDAR_NAME:
                return cal["uid"]

        await self._ensure_token()
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            create_resp = await client.post(
                f"{self._base_url}/calendars",
                headers=self._auth_headers(),
                # Zoho Calendar's write endpoints don't take a JSON body —
                # they take a single query param ("calendarData" here) whose
                # value is the JSON payload as a string. "color" is
                # mandatory; omitting it is exactly what produced the
                # LESS_THAN_MIN_OCCURANCE error this comment replaced.
                params={
                    "calendarData": json.dumps(
                        {
                            "name": DEADLINES_CALENDAR_NAME,
                            "color": "#E42527",
                            "description": (
                                "Tax deadlines and collection launches, "
                                "kept in sync automatically by ThreadWise."
                            ),
                        }
                    )
                },
            )
            _raise_with_body(create_resp)
            return create_resp.json()["calendars"][0]["uid"]

    # -------------------------------------------------------------------------
    # Events (pull)
    # -------------------------------------------------------------------------

    async def stream_events(
        self,
        calendar_uid: str,
        window_start: datetime,
        window_end: datetime,
    ) -> AsyncIterator[RawEventRecord]:
        """Stream every event in one calendar within [window_start, window_end).

        Chunks the window into <=EVENT_RANGE_MAX_DAYS slices — Zoho's
        "range" param is mandatory and capped at 31 days per request (see
        module docstring), unlike Shopify's cursor-based pagination.
        """
        slice_start = window_start
        while slice_start < window_end:
            slice_end = min(
                slice_start + timedelta(days=EVENT_RANGE_MAX_DAYS), window_end
            )

            await self._ensure_token()
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.get(
                    f"{self._base_url}/calendars/{calendar_uid}/events",
                    headers=self._auth_headers(),
                    params={
                        "range": json.dumps(
                            {
                                "start": slice_start.strftime("%Y%m%dT%H%M%SZ"),
                                "end": slice_end.strftime("%Y%m%dT%H%M%SZ"),
                            }
                        )
                    },
                )
                _raise_with_body(resp)
                events = resp.json().get("events", [])

            fetched_at = datetime.now(timezone.utc)
            for event in events:
                uid = event.get("uid")
                if not uid:
                    continue
                dateandtime = event.get("dateandtime") or {}
                yield RawEventRecord(
                    provider="zoho_calendar",
                    entity_type="calendar_event",
                    external_id=uid,
                    payload=event,
                    occurred_at=_parse_zoho_event_datetime(dateandtime.get("start")),
                    fetched_at=fetched_at,
                )

            logger.info(
                "Fetched Zoho Calendar %s events for calendar %s, slice %s–%s",
                len(events),
                calendar_uid,
                slice_start.date(),
                slice_end.date(),
            )
            slice_start = slice_end

    def _build_event_data(
        self,
        title: str,
        start_at: datetime,
        end_at: datetime,
        all_day: bool,
        description: Optional[str],
        location: Optional[str],
    ) -> str:
        """Build the "eventdata" query-param JSON for create/update.

        Per Zoho's create-event docs, dateandtime uses "yyyyMMdd'T'HHmmss'Z'"
        (timed) or "yyyyMMdd" (all-day) — the "Z"-suffixed form the docs
        specify for requests, not the local-offset form GET responses
        actually return (see module docstring).
        """
        if all_day:
            start_str = start_at.astimezone(timezone.utc).strftime("%Y%m%d")
            end_str = end_at.astimezone(timezone.utc).strftime("%Y%m%d")
        else:
            start_str = start_at.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            end_str = end_at.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

        event: Dict[str, Any] = {
            "title": title,
            "dateandtime": {"start": start_str, "end": end_str},
            "isallday": all_day,
        }
        if description:
            event["description"] = description
        if location:
            event["location"] = location
        return json.dumps(event)

    async def create_event(
        self,
        calendar_uid: str,
        title: str,
        start_at: datetime,
        end_at: datetime,
        all_day: bool = False,
        description: Optional[str] = None,
        location: Optional[str] = None,
    ) -> str:
        """Create an event in the given calendar. Returns the new event's uid."""
        await self._ensure_token()
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self._base_url}/calendars/{calendar_uid}/events",
                headers=self._auth_headers(),
                params={
                    "eventdata": self._build_event_data(
                        title, start_at, end_at, all_day, description, location
                    )
                },
            )
            _raise_with_body(resp)
            return resp.json()["events"][0]["uid"]

    async def update_event(
        self,
        calendar_uid: str,
        event_uid: str,
        title: str,
        start_at: datetime,
        end_at: datetime,
        all_day: bool = False,
        description: Optional[str] = None,
        location: Optional[str] = None,
    ) -> str:
        """Replace an existing event's data. Returns the event's uid.

        Full-replace semantics (confirmed from Zoho's docs), not a partial
        patch — every field this adapter cares about must be resent.
        """
        await self._ensure_token()
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.put(
                f"{self._base_url}/calendars/{calendar_uid}/events/{event_uid}",
                headers=self._auth_headers(),
                params={
                    "eventdata": self._build_event_data(
                        title, start_at, end_at, all_day, description, location
                    )
                },
            )
            _raise_with_body(resp)
            return resp.json()["events"][0]["uid"]

    async def test_connection(self) -> bool:
        """Validate credentials by refreshing a token and listing calendars."""
        try:
            await self.list_calendars()
            return True
        except Exception as e:
            logger.error("Zoho Calendar connection test failed: %s", e)
            return False
