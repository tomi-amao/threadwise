"""Notifications: what needs the user, shown under the bell in the app.

The table is `notifications` (supabase/migrations/20261107000000_notifications.sql). Code that
finds a problem calls `notify()` with a key naming the thing it is about
(`"integration_access:<source id>"`), and `resolve()` with the same key once the problem is
gone. Only one notification per business and key is open at a time, so a check that runs every
day refreshes the open notification instead of adding another, and does not mark it unread
again: a notification the user has read stays read until it is resolved and something new
opens.

Written with the service role, so callers must already know the business is the right one
(a background job working on its own rows, or a route that checked the caller).
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from ..core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

TABLE = "notifications"
UNIQUE_VIOLATION = "23505"


@dataclass(frozen=True)
class Notified:
    """The open notification for a key, and whether this call opened it."""

    id: str
    created: bool


def check_link(link: Optional[str]) -> None:
    """A link is a path inside the app ("/integrations?app=..."), never another site."""
    if link is None:
        return
    if not link.startswith("/") or link.startswith("//") or link.startswith("/\\"):
        raise ValueError(f"A notification links inside the app, not to {link!r}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class NotificationService:
    def __init__(self, client: Any = None):
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    async def _open(self, entity_id: str, key: str) -> Optional[dict]:
        result = await asyncio.to_thread(
            lambda: self.client.table(TABLE)
            .select("id, title, body, link")
            .eq("entity_id", entity_id)
            .eq("dedupe_key", key)
            .is_("resolved_at", "null")
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    async def notify(
        self,
        entity_id: UUID | str,
        kind: str,
        key: str,
        title: str,
        body: Optional[str] = None,
        link: Optional[str] = None,
    ) -> Notified:
        """Open a notification about `key`, or refresh the one that is open.

        Refreshing changes its wording (a count that grew) but not whether it was read.
        """
        check_link(link)
        entity = str(entity_id)
        content = {"title": title, "body": body, "link": link}

        existing = await self._open(entity, key)
        if existing is None:
            row = {"entity_id": entity, "kind": kind, "dedupe_key": key, **content}
            try:
                result = await asyncio.to_thread(
                    lambda: self.client.table(TABLE).insert(row).execute()
                )
                return Notified(id=result.data[0]["id"], created=True)
            except Exception as e:
                # Another run opened it between our read and our insert: use that one.
                if UNIQUE_VIOLATION not in str(getattr(e, "code", "")) + str(e):
                    raise
                existing = await self._open(entity, key)
                if existing is None:
                    raise

        if any(existing.get(k) != v for k, v in content.items()):
            await asyncio.to_thread(
                lambda: self.client.table(TABLE)
                .update({**content, "updated_at": _now()})
                .eq("id", existing["id"])
                .execute()
            )
        return Notified(id=existing["id"], created=False)

    async def resolve(self, entity_id: UUID | str, key: str) -> bool:
        """Close the open notification about `key`. True if there was one."""
        result = await asyncio.to_thread(
            lambda: self.client.table(TABLE)
            .update({"resolved_at": _now(), "updated_at": _now()})
            .eq("entity_id", str(entity_id))
            .eq("dedupe_key", key)
            .is_("resolved_at", "null")
            .execute()
        )
        return bool(result.data)


notification_service = NotificationService()
