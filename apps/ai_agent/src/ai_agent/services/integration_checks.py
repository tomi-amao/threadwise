"""The checks behind the bell: what about a business's integrations needs the user.

Three things, each one notification per thing it is about (see services/notifications.py):

- **Access** (`integration_access:<source id>`): the provider refused the stored key. Opened
  when a check is refused, resolved when one succeeds. A check that gets no answer (a
  timeout, the provider is down) changes nothing, so one bad night does not tell anyone
  their Shopify broke.
- **Stale** (`integration_stale:<source id>`): no sync for STALE_AFTER (14 days, the same as
  the amber "Last synced" on the Integrations page, `STALE_AFTER_DAYS` in model.tsx). A
  source never synced is not stale, and neither is one whose access is failing: that
  notification already says what to do.
- **Journals** (`journals_needed`): payments and transactions that Generate journals would
  still journal. Resolved when there are none left.

Hidden integrations are checked like any other: hiding only tidies the page.
The Inngest functions that run these are in integrations/inngest/notification_functions.py.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

from .notifications import NotificationService, notification_service
from .source_access import check_source

logger = logging.getLogger(__name__)

STALE_AFTER = timedelta(days=14)

ACCESS = "integration_access"
STALE = "integration_stale"
JOURNALS = "journals_needed"

PROVIDER_NAMES = {
    "shopify": "Shopify",
    "squarespace": "Squarespace",
    "paypal": "PayPal",
    "revolut": "Revolut",
    "revolut_merchant": "Revolut Merchant",
    "zoho_calendar": "Zoho Calendar",
}


def access_key(source_id: str) -> str:
    return f"{ACCESS}:{source_id}"


def stale_key(source_id: str) -> str:
    return f"{STALE}:{source_id}"


def provider_name(provider: Optional[str]) -> str:
    return PROVIDER_NAMES.get(provider or "", (provider or "An integration").title())


def app_link(source: Dict[str, Any]) -> str:
    """The integration's drawer on the Integrations page.

    The Revolut Merchant key is a child row of the Revolut integration (its
    `external_account_id` is the Revolut row's id), and is shown inside that drawer.
    """
    if source.get("provider") == "revolut_merchant" and source.get(
        "external_account_id"
    ):
        return f"/integrations?app={source['external_account_id']}"
    return f"/integrations?app={source['id']}"


JOURNALS_LINK = "/journals?generate=1"


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_stale(last_synced_at: Optional[str], now: datetime) -> bool:
    synced = _parse(last_synced_at)
    return synced is not None and now - synced > STALE_AFTER


def stale_title(provider: Optional[str], last_synced_at: str, now: datetime) -> str:
    synced = _parse(last_synced_at)
    assert synced is not None
    weeks = (now - synced).days // 7
    return f"{provider_name(provider)} hasn't synced in {weeks} weeks"


def journals_title(count: int) -> str:
    if count == 1:
        return "1 payment needs a journal"
    return f"{count} payments need journals"


@dataclass
class SourceOutcome:
    source_id: str
    provider: str
    access: str  # "valid" | "refused" | "unknown"
    stale: bool = False


@dataclass
class EntityOutcome:
    entity_id: str
    sources: List[SourceOutcome] = field(default_factory=list)
    awaiting_journals: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "entity_id": self.entity_id,
            "sources": [vars(s) for s in self.sources],
            "awaiting_journals": self.awaiting_journals,
        }


class IntegrationChecks:
    def __init__(
        self,
        sync: Any = None,
        journals: Any = None,
        notifications: Optional[NotificationService] = None,
        check: Any = None,
    ):
        self._sync = sync
        self._journals = journals
        self.notifications = notifications or notification_service
        self.check = check or check_source

    @property
    def sync(self) -> Any:
        if self._sync is None:
            from .external_sync_service import sync_service

            self._sync = sync_service
        return self._sync

    @property
    def journals(self) -> Any:
        if self._journals is None:
            from .journal_service import journal_service

            self._journals = journal_service
        return self._journals

    async def entities_with_sources(self) -> List[str]:
        """Every business with at least one connected integration."""
        sources = await self.sync.list_external_sources()
        return sorted({s["entity_id"] for s in sources if s.get("entity_id")})

    async def check_access(self, source: Dict[str, Any]) -> str:
        """Ask the provider; open or resolve the access notification. Returns the state."""
        source_id, entity_id = source["id"], source["entity_id"]
        api_key = await self.sync.get_api_key(source_id)
        ok, message = await self.check(source, api_key)
        name = provider_name(source.get("provider"))

        if ok is None:
            logger.info(
                "Access check for %s (%s) got no answer: %s", source_id, name, message
            )
            return "unknown"
        if ok:
            await self.sync.update_api_key_status(source_id, "valid")
            await self.notifications.resolve(entity_id, access_key(source_id))
            return "valid"

        await self.sync.update_api_key_status(source_id, "invalid", message)
        fix = (
            "Reconnect it on the Integrations page."
            if source.get("provider") == "zoho_calendar"
            else "Update its key on the Integrations page, then sync again."
        )
        await self.notifications.notify(
            entity_id,
            ACCESS,
            access_key(source_id),
            f"{name} access stopped working",
            f"{name} refused ThreadWise's key ({message or 'no reason given'}), so "
            f"nothing new comes in from it. {fix}",
            app_link(source),
        )
        return "refused"

    async def check_stale(self, source: Dict[str, Any], now: datetime) -> bool:
        """Open or resolve the "hasn't synced" notification. True if stale."""
        source_id, entity_id = source["id"], source["entity_id"]
        last = source.get("last_synced_at")
        if not is_stale(last, now):
            await self.notifications.resolve(entity_id, stale_key(source_id))
            return False
        assert last is not None
        synced = _parse(last)
        assert synced is not None
        await self.notifications.notify(
            entity_id,
            STALE,
            stale_key(source_id),
            stale_title(source.get("provider"), last, now),
            f"Last synced on {synced.day} {synced.strftime('%B %Y')}. Sync it to bring in "
            "what has happened since.",
            app_link(source),
        )
        return True

    async def check_one(
        self, source: Dict[str, Any], now: Optional[datetime] = None
    ) -> SourceOutcome:
        now = now or datetime.now(timezone.utc)
        access = await self.check_access(source)
        outcome = SourceOutcome(source["id"], source.get("provider") or "", access)
        # The Revolut Merchant key syncs as part of the Revolut integration, so the
        # Revolut row's last sync is the one that matters. A refused key already has its
        # notification: leave any "hasn't synced" one as it is until access is back.
        if source.get("provider") != "revolut_merchant" and access != "refused":
            outcome.stale = await self.check_stale(source, now)
        return outcome

    async def check_journals(self, entity_id: str) -> int:
        """Open, refresh or resolve the journals notification. Returns the count."""
        count: int = await self.journals.count_awaiting_journals(UUID(entity_id))
        if count == 0:
            await self.notifications.resolve(entity_id, JOURNALS)
            return 0
        await self.notifications.notify(
            entity_id,
            JOURNALS,
            JOURNALS,
            journals_title(count),
            "Sales, payouts and expenses that have come in with no journal yet. "
            "Generate journals to post them to your books.",
            JOURNALS_LINK,
        )
        return count

    async def sources_of(self, entity_id: str) -> List[Dict[str, Any]]:
        sources: List[Dict[str, Any]] = await self.sync.list_external_sources(
            entity_id=entity_id
        )
        return sources

    async def check_entity(
        self, entity_id: str, now: Optional[datetime] = None
    ) -> EntityOutcome:
        """Everything for one business. One source failing to check does not stop the rest."""
        outcome = EntityOutcome(entity_id)
        for source in await self.sources_of(entity_id):
            try:
                outcome.sources.append(await self.check_one(source, now))
            except Exception:
                logger.exception("Integration check failed for source %s", source["id"])
        outcome.awaiting_journals = await self.check_journals(entity_id)
        return outcome


integration_checks = IntegrationChecks()
