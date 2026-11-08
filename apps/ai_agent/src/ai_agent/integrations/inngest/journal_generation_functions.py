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
from typing import Any, Dict, List, Tuple, cast
from uuid import UUID

import inngest
from inngest.experimental import realtime

from ...services.journal_runs import journal_runs
from ...services.journal_service import journal_service, recording_generation_run
from .channels import (
    JournalPipelineStatusData,
    JournalStepProgressData,
    get_journal_channel,
)
from .config import get_client
from .notification_functions import journals_check_event

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


async def _mark_running(run_id: str) -> None:
    await journal_runs.mark_running(run_id)


async def _run_pipeline_step(method_name: str, entity_id: UUID, run_id: str) -> Any:
    """One pipeline step, with every journal it creates linked to this run."""
    with recording_generation_run(run_id):
        return await getattr(journal_service, method_name)(entity_id)


async def _save_progress(
    run_id: str, steps: List[Dict[str, Any]], totals: Dict[str, int]
) -> None:
    await journal_runs.save_progress(run_id, steps, totals)


async def _finish_run(
    run_id: str, status: str, steps: List[Dict[str, Any]], totals: Dict[str, int]
) -> None:
    await journal_runs.finish_run(run_id, status, steps, totals)


async def _fail_run(run_id: str, reason: str) -> None:
    await journal_runs.fail_run(run_id, reason)


def _processed_count(result: Dict[str, Any]) -> int | None:
    for key in _PROCESSED_COUNT_KEYS:
        if key in result:
            count: int = result[key]
            return count
    return None


async def _generation_failed(ctx: inngest.Context) -> None:
    """The job died outright: close its run, and tell a modal that is still watching.

    Errors inside a step do not reach here (the job records them and carries on), so
    this is for what the job cannot record itself, such as its retries running out.
    """
    failed: Dict[str, Any] = dict(ctx.event.data)
    original = cast(Dict[str, Any], failed.get("event") or {})
    data = cast(Dict[str, Any], original.get("data") or {})
    run_id, entity_id = data.get("run_id"), data.get("entity_id")
    if not run_id or not entity_id:
        return

    reason = "The run stopped unexpectedly."
    await ctx.step.run("fail-run", _fail_run, run_id, reason)
    await realtime.publish(
        client=inngest_client,
        channel=get_journal_channel(str(entity_id)),
        topic="status",
        data=JournalPipelineStatusData(
            status="error",
            scope=str(data.get("scope") or "all"),
            steps_completed=0,
            steps_total=0,
            total_created=0,
            total_skipped=0,
            total_errors=0,
            error=reason,
            timestamp=_now_iso(),
            run_id=str(run_id),
        ),
    )


@inngest_client.create_function(
    fn_id="generate_all_journals",
    trigger=inngest.TriggerEvent(event="accounting/journals.generate.requested"),
    retries=2,
    on_failure=_generation_failed,
)
async def generate_all_journals_job(ctx: inngest.Context) -> Dict[str, Any]:
    """Background journal-generation pipeline with realtime step progress."""
    event_data: Dict[str, Any] = dict(ctx.event.data)
    entity_id_str = event_data.get("entity_id")
    scope = event_data.get("scope")  # None/"all" runs every step
    run_id = event_data.get("run_id")

    if not entity_id_str or not run_id:
        raise ValueError("entity_id and run_id are required")

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

    def _totals() -> Dict[str, int]:
        return {
            "total_created": total_created,
            "total_skipped": total_skipped,
            "total_errors": len(overall_errors),
        }

    await ctx.step.run("mark-running", _mark_running, run_id)

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
            run_id=run_id,
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
            result = await ctx.step.run(
                step_key, _run_pipeline_step, method_name, entity_id, run_id
            )
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
            await ctx.step.run(
                f"save-{step_key}", _save_progress, run_id, steps_result, _totals()
            )

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

        await ctx.step.run(
            f"save-{step_key}", _save_progress, run_id, steps_result, _totals()
        )

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
                run_id=run_id,
            ),
        )

    failed_steps = [s["step"] for s in steps_result if s["status"] == "error"]
    final_status = "completed" if not failed_steps else "completed_with_errors"
    await ctx.step.run(
        "finish-run", _finish_run, run_id, final_status, steps_result, _totals()
    )

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
            run_id=run_id,
        ),
    )

    ctx.logger.info(
        f"Completed journal generation for entity {entity_id_str}: "
        f"{total_created} created, {total_skipped} skipped, "
        f"{len(overall_errors)} errors"
    )

    # Bring the "payments need journals" notification up to date with what is left.
    await ctx.step.send_event("check-journals", journals_check_event(entity_id_str))

    return {
        "entity_id": entity_id_str,
        "run_id": run_id,
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
