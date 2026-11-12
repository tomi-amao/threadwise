"""The record of each background journal generation run (``journal_generation_runs``).

A run's row is created when the user clicks Generate, before the job is queued, so the
caller has an id straight away and a job that never starts still leaves a trace. What
happened (steps, totals, errors) is saved here as it happens and not changed afterwards;
what is true now (drafts still open, journals reversed since) is read from the journals
whose ``generation_run_id`` points at the run.

Uses the service-role client, so callers must already have checked the business is the
caller's (``api/deps.py``).
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from postgrest.exceptions import APIError

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_row
from .notifications import NotificationService, notification_service

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = ("queued", "running")
# Far longer than any real run. A job Inngest lost must not block new runs for ever.
ABANDONED_AFTER = timedelta(hours=2)
ABANDONED_REASON = "The run did not finish."
# A step can fail on thousands of items, and this is a jsonb column read by a list page.
MAX_STORED_ERRORS = 200
_UNIQUE_VIOLATION = "23505"
# One open notification per business about how generating journals went: the latest run.
RUN_NOTICE = "journal_run_problems"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def compact_step(step: Dict[str, Any]) -> Dict[str, Any]:
    """A step's result as stored: a capped error list, and per-type counts only."""
    compact = dict(step)
    errors = list(step.get("errors") or [])
    compact["errors"] = errors[:MAX_STORED_ERRORS]
    compact["errors_total"] = len(errors)
    if step.get("by_type"):
        compact["by_type"] = {
            kind: {
                "total": detail.get("total", 0),
                "created": detail.get("created", 0),
                "skipped": detail.get("skipped", 0),
                "errors": len(detail.get("errors") or []),
            }
            for kind, detail in step["by_type"].items()
        }
    return compact


def run_link(run_id: str) -> str:
    return f"/journals?tab=runs&run={run_id}"


def outcome_notice(status: str, totals: Dict[str, int]) -> Optional[Tuple[str, str]]:
    """The bell's title and body for how a run ended, or None when it went cleanly."""
    if status == "failed":
        return (
            "Generating journals did not finish",
            "Open the run to see how far it got, then generate journals again.",
        )
    errors = totals.get("total_errors", 0)
    if status != "completed_with_errors" and errors == 0:
        return None
    problems = max(errors, 1)
    created = totals.get("total_created", 0)
    return (
        f"Generating journals hit {problems} problem{'' if problems == 1 else 's'}",
        f"It created {created} journal{'' if created == 1 else 's'}. "
        "Open the run to see what went wrong.",
    )


async def tell_the_user(
    entity_id: str,
    run_id: str,
    status: str,
    totals: Dict[str, int],
    notifications: NotificationService = notification_service,
) -> None:
    """Put a run that ended badly under the bell, and clear the bell after a clean one.

    The earlier notice is closed first, so a new run with problems opens a new, unread
    notification instead of quietly rewording one the user has already read.
    """
    await notifications.resolve(entity_id, RUN_NOTICE)
    notice = outcome_notice(status, totals)
    if notice is None:
        return
    title, body = notice
    await notifications.notify(
        entity_id, RUN_NOTICE, RUN_NOTICE, title, body, run_link(run_id)
    )


class JournalRunStore:
    def __init__(self):
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    def _table(self):
        return self.client.table("journal_generation_runs")

    async def _update(self, run_id: str, values: Dict[str, Any]) -> None:
        await asyncio.to_thread(
            lambda: self._table().update(values).eq("id", run_id).execute()
        )

    async def start_run(
        self, entity_id: UUID, scope: str
    ) -> Tuple[Dict[str, Any], bool]:
        """Create a queued run, or return the one already going.

        Returns ``(run, created)``. The database's unique index decides, so two clicks
        at the same moment cannot both start a run.
        """
        await self._close_abandoned(entity_id)
        try:
            result = await asyncio.to_thread(
                lambda: self._table()
                .insert({"entity_id": str(entity_id), "scope": scope})
                .execute()
            )
        except APIError as e:
            if e.code != _UNIQUE_VIOLATION:
                raise
            active = await self._active_run(entity_id)
            if active is None:
                raise
            return active, False
        run = extract_row(result)
        if run is None:
            raise RuntimeError("The journal run was not created")
        return run, True

    async def _close_abandoned(self, entity_id: UUID) -> None:
        cutoff = (datetime.now(timezone.utc) - ABANDONED_AFTER).isoformat()
        await asyncio.to_thread(
            lambda: self._table()
            .update(
                {
                    "status": "failed",
                    "failure_reason": ABANDONED_REASON,
                    "finished_at": _now(),
                }
            )
            .eq("entity_id", str(entity_id))
            .in_("status", list(ACTIVE_STATUSES))
            .lt("created_at", cutoff)
            .execute()
        )

    async def _active_run(self, entity_id: UUID) -> Optional[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self._table()
            .select("*")
            .eq("entity_id", str(entity_id))
            .in_("status", list(ACTIVE_STATUSES))
            .limit(1)
            .execute()
        )
        return extract_row(result)

    async def get_active_run(self, entity_id: UUID) -> Optional[Dict[str, Any]]:
        """The run going now, so a reopened modal can show it. A lost one does not count."""
        run = await self._active_run(entity_id)
        if run is None:
            return None
        created = datetime.fromisoformat(str(run["created_at"]))
        if datetime.now(timezone.utc) - created > ABANDONED_AFTER:
            return None
        return run

    async def get_run(self, entity_id: UUID, run_id: UUID) -> Optional[Dict[str, Any]]:
        """The run, only if it is this business's."""
        result = await asyncio.to_thread(
            lambda: self._table()
            .select("*")
            .eq("entity_id", str(entity_id))
            .eq("id", str(run_id))
            .limit(1)
            .execute()
        )
        return extract_row(result)

    async def mark_running(self, run_id: str) -> None:
        await self._update(run_id, {"status": "running", "started_at": _now()})

    async def save_progress(
        self, run_id: str, steps: List[Dict[str, Any]], totals: Dict[str, int]
    ) -> None:
        await self._update(
            run_id, {"steps": [compact_step(s) for s in steps], **totals}
        )

    async def finish_run(
        self,
        run_id: str,
        status: str,
        steps: List[Dict[str, Any]],
        totals: Dict[str, int],
    ) -> None:
        await self._update(
            run_id,
            {
                "status": status,
                "finished_at": _now(),
                "steps": [compact_step(s) for s in steps],
                **totals,
            },
        )

    async def fail_run(self, run_id: str, reason: str) -> None:
        """Close a run that could not finish. A run already closed is left as it was."""
        await asyncio.to_thread(
            lambda: self._table()
            .update(
                {"status": "failed", "failure_reason": reason, "finished_at": _now()}
            )
            .eq("id", run_id)
            .in_("status", list(ACTIVE_STATUSES))
            .execute()
        )

    async def save_narrative(self, run_id: str, narrative: Dict[str, Any]) -> None:
        await self._update(run_id, {"narrative": narrative})


journal_runs = JournalRunStore()
