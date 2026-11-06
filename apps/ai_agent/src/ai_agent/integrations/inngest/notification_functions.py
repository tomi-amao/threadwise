"""Inngest functions that keep the bell's notifications up to date.

- `check_integrations_daily` (cron, 06:00 UTC) sends one event per business with an
  integration, so each business is its own run: one business's slow provider or failure
  does not hold up or fail the others, and each retries on its own.
- `check_business_integrations` checks that business's keys, its last syncs and what is
  waiting for journals (services/integration_checks.py).
- `check_journals_after_load` updates the journals notification after data comes in
  (the end of every load, `normalize_source`) and after journals are generated. It is
  debounced per business, so a full sync that loads several sources counts once.
"""

import logging
from datetime import timedelta
from typing import Any, Dict, List

import inngest

from .config import get_client

logger = logging.getLogger(__name__)

inngest_client = get_client()

CHECK_BUSINESS = "notifications/integrations.check.requested"
CHECK_JOURNALS = "notifications/journals.check.requested"


def journals_check_event(entity_id: str) -> inngest.Event:
    return inngest.Event(name=CHECK_JOURNALS, data={"entity_id": str(entity_id)})


def _checks() -> Any:
    # Imported here, as the sync functions do: services import integrations, whose
    # package loads every Inngest function.
    from ...services.integration_checks import integration_checks

    return integration_checks


@inngest_client.create_function(
    fn_id="check_integrations_daily",
    trigger=inngest.TriggerCron(cron="0 6 * * *"),  # Daily at 06:00 UTC
    retries=2,
)
async def check_integrations_daily(ctx: inngest.Context) -> Dict[str, Any]:
    """Start one check per business that has an integration."""
    entity_ids: List[str] = await ctx.step.run(
        "list-businesses", lambda: _checks().entities_with_sources()
    )
    if entity_ids:
        await ctx.step.send_event(
            "check-each-business",
            [
                inngest.Event(name=CHECK_BUSINESS, data={"entity_id": entity_id})
                for entity_id in entity_ids
            ],
        )
    return {"businesses": len(entity_ids)}


@inngest_client.create_function(
    fn_id="check_business_integrations",
    trigger=inngest.TriggerEvent(event=CHECK_BUSINESS),
    # One check per business at a time; a second request for the same business waits.
    concurrency=[inngest.Concurrency(limit=1, key="event.data.entity_id")],
    retries=2,
)
async def check_business_integrations(ctx: inngest.Context) -> Dict[str, Any]:
    """Keys, last syncs and journals for one business."""
    event_data: Dict[str, Any] = dict(ctx.event.data)
    entity_id = str(event_data.get("entity_id") or "")
    if not entity_id:
        raise ValueError("entity_id is required")

    sources: List[Dict[str, Any]] = await ctx.step.run(
        "list-sources", lambda: _checks().sources_of(entity_id)
    )
    results: List[Dict[str, Any]] = []
    for source in sources:
        # Each source is its own step, so a retry does not ask every provider again.
        async def _one(source: Dict[str, Any] = source) -> Dict[str, Any]:
            try:
                checked: Dict[str, Any] = vars(await _checks().check_one(source))
                return checked
            except Exception as e:
                logger.exception("Integration check failed for source %s", source["id"])
                return {"source_id": source["id"], "error": str(e)}

        results.append(await ctx.step.run(f"check-source-{source['id']}", _one))

    awaiting: int = await ctx.step.run(
        "check-journals", lambda: _checks().check_journals(entity_id)
    )
    return {"entity_id": entity_id, "sources": results, "awaiting_journals": awaiting}


@inngest_client.create_function(
    fn_id="check_journals_after_load",
    trigger=inngest.TriggerEvent(event=CHECK_JOURNALS),
    debounce=inngest.Debounce(period=timedelta(minutes=2), key="event.data.entity_id"),
    retries=2,
)
async def check_journals_after_load(ctx: inngest.Context) -> Dict[str, Any]:
    """Count what is waiting for journals and update the notification."""
    event_data: Dict[str, Any] = dict(ctx.event.data)
    entity_id = str(event_data.get("entity_id") or "")
    if not entity_id:
        raise ValueError("entity_id is required")
    awaiting: int = await ctx.step.run(
        "check-journals", lambda: _checks().check_journals(entity_id)
    )
    return {"entity_id": entity_id, "awaiting_journals": awaiting}


NOTIFICATION_FUNCTIONS = [
    check_integrations_daily,
    check_business_integrations,
    check_journals_after_load,
]
