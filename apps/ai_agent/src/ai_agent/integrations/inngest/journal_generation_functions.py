"""Inngest function for background journal generation.

Runs the journal-generation pipeline (accrue payments, settle payouts,
journal inbound transactions, journal expenses) as a background job with
step-level retries and realtime progress — the same architecture the sync
pipeline already uses (see shopify_sync_functions.py), rather than blocking
an HTTP request for however long the whole pipeline takes.

Business logic (idempotency, account resolution, per-item error handling)
stays in journal_service.py's auto_journal_* methods unchanged; this module
is purely the orchestration/progress layer around them. Each of the four
steps below is wrapped in its own ctx.step.run, so a transient failure in
one step retries just that step rather than the whole pipeline, and each
step's completion is published over realtime — this is step-level
granularity (one update per step, not per item within a step), matching
the four-step model the UI already presents.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple
from uuid import UUID

import inngest
from inngest.experimental import realtime

from ...services.journal_service import journal_service
from .channels import (
    JournalPipelineStatusData,
    JournalStepProgressData,
    get_journal_channel,
)
from .config import get_client

logger = logging.getLogger(__name__)

inngest_client = get_client()

# (step key, display title, journal_service method name, scope it belongs to)
PIPELINE_STEPS: List[Tuple[str, str, str, str]] = [
    (
        "journal_payments",
        "Accrue Payments (Revenue Recognition)",
        "auto_journal_payments",
        "payments",
    ),
    (
        "journal_settlements",
        "Settle Gateway Payouts",
        "auto_journal_settlements",
        "transactions",
    ),
    (
        "journal_inbound",
        "Journal Inbound Transactions",
        "auto_journal_inbound",
        "transactions",
    ),
    ("journal_expenses", "Journal Expenses", "auto_journal_expenses", "transactions"),
]

# Result dict keys each auto_journal_* method uses for its "how many items did
# I look at" count — they're named differently per method (payments_processed
# vs. transactions_processed) but each result only ever has one of them set.
_PROCESSED_COUNT_KEYS = (
    "payments_processed",
    "settlements_processed",
    "transactions_processed",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _processed_count(result: Dict[str, Any]) -> int | None:
    for key in _PROCESSED_COUNT_KEYS:
        if key in result:
            count: int = result[key]
            return count
    return None


@inngest_client.create_function(
    fn_id="generate_all_journals",
    trigger=inngest.TriggerEvent(event="accounting/journals.generate.requested"),
    retries=2,
)
async def generate_all_journals_job(ctx: inngest.Context) -> Dict[str, Any]:
    """Background journal-generation pipeline with realtime step progress."""
    event_data: Dict[str, Any] = dict(ctx.event.data)
    entity_id_str = event_data.get("entity_id")
    scope = event_data.get("scope")  # None/"all" runs every step

    if not entity_id_str:
        raise ValueError("entity_id is required")

    entity_id = UUID(entity_id_str)
    run_all = scope is None or scope == "all"
    channel = get_journal_channel(entity_id_str)

    applicable_steps = [s for s in PIPELINE_STEPS if run_all or s[3] == scope]

    ctx.logger.info(
        f"Starting journal generation for entity {entity_id_str} "
        f"(scope: {scope or 'all'}, {len(applicable_steps)} steps)"
    )

    steps_result: List[Dict[str, Any]] = []
    overall_errors: List[Dict[str, Any]] = []
    total_created = 0
    total_skipped = 0

    await realtime.publish(
        client=inngest_client,
        channel=channel,
        topic="status",
        data=JournalPipelineStatusData(
            status="running",
            scope=scope or "all",
            steps_completed=0,
            steps_total=len(applicable_steps),
            total_created=0,
            total_skipped=0,
            total_errors=0,
            error=None,
            timestamp=_now_iso(),
        ),
    )

    for i, (step_key, title, method_name, _) in enumerate(applicable_steps):
        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="progress",
            data=JournalStepProgressData(
                step=step_key,
                title=title,
                status="starting",
                created=0,
                skipped=0,
                errors=[],
                total_items=None,
                step_error=None,
                by_type=None,
                passthrough=None,
                timestamp=_now_iso(),
            ),
        )

        try:
            method = getattr(journal_service, method_name)
            result = await ctx.step.run(step_key, method, entity_id)
        except Exception as e:
            ctx.logger.error(f"Journal step {step_key} failed: {e}")
            steps_result.append(
                {
                    "step": step_key,
                    "title": title,
                    "status": "error",
                    "error": str(e),
                }
            )
            overall_errors.append({"step": step_key, "error": str(e)})

            await realtime.publish(
                client=inngest_client,
                channel=channel,
                topic="progress",
                data=JournalStepProgressData(
                    step=step_key,
                    title=title,
                    status="error",
                    created=0,
                    skipped=0,
                    errors=[],
                    total_items=None,
                    step_error=str(e),
                    by_type=None,
                    passthrough=None,
                    timestamp=_now_iso(),
                ),
            )
            continue

        created = result.get("created", 0)
        skipped = result.get("skipped", 0)
        item_errors = result.get("errors", [])
        total_created += created
        total_skipped += skipped

        step_record: Dict[str, Any] = {
            "step": step_key,
            "title": title,
            "status": "completed",
            "created": created,
            "skipped": skipped,
            "errors": item_errors,
        }
        # journal_inbound's result carries extra detail (by_type, passthrough)
        # the modal's step summary already knows how to render — pass it
        # through rather than flattening it away.
        for extra_key in ("by_type", "passthrough"):
            if extra_key in result:
                step_record[extra_key] = result[extra_key]
        steps_result.append(step_record)

        for err in item_errors:
            overall_errors.append({"step": step_key, **err})

        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="progress",
            data=JournalStepProgressData(
                step=step_key,
                title=title,
                status="completed",
                created=created,
                skipped=skipped,
                errors=item_errors,
                total_items=_processed_count(result),
                step_error=None,
                by_type=result.get("by_type"),
                passthrough=result.get("passthrough"),
                timestamp=_now_iso(),
            ),
        )

        await realtime.publish(
            client=inngest_client,
            channel=channel,
            topic="status",
            data=JournalPipelineStatusData(
                status="running",
                scope=scope or "all",
                steps_completed=i + 1,
                steps_total=len(applicable_steps),
                total_created=total_created,
                total_skipped=total_skipped,
                total_errors=len(overall_errors),
                error=None,
                timestamp=_now_iso(),
            ),
        )

    failed_steps = [s["step"] for s in steps_result if s["status"] == "error"]
    final_status = "completed" if not failed_steps else "completed_with_errors"

    await realtime.publish(
        client=inngest_client,
        channel=channel,
        topic="status",
        data=JournalPipelineStatusData(
            status=final_status,
            scope=scope or "all",
            steps_completed=len(applicable_steps),
            steps_total=len(applicable_steps),
            total_created=total_created,
            total_skipped=total_skipped,
            total_errors=len(overall_errors),
            error=None,
            timestamp=_now_iso(),
        ),
    )

    ctx.logger.info(
        f"Completed journal generation for entity {entity_id_str}: "
        f"{total_created} created, {total_skipped} skipped, "
        f"{len(overall_errors)} errors"
    )

    return {
        "entity_id": entity_id_str,
        "scope": scope or "all",
        "status": final_status,
        "steps": steps_result,
        "summary": {
            "total_journals_created": total_created,
            "total_skipped": total_skipped,
            "total_errors": len(overall_errors),
            "failed_steps": failed_steps,
        },
        "errors": overall_errors,
        "completed_at": _now_iso(),
    }


JOURNAL_GENERATION_FUNCTIONS = [generate_all_journals_job]
