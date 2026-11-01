"""Inngest function that matches uploaded invoices to the transactions that paid them.

``match_invoice_payments`` runs on ``invoices/match.requested``: sent after each Revolut or
PayPal sync has been normalised (new transactions may pay invoices already uploaded), and by
``POST /accounting/invoices/match`` for a pass on demand. The work is
``services/invoice_matching.match_unlinked``.
"""

import logging
from typing import Any, Dict
from uuid import UUID

import inngest

from .config import get_client

logger = logging.getLogger(__name__)

inngest_client = get_client()

MATCH_INVOICES_EVENT = "invoices/match.requested"


@inngest_client.create_function(
    fn_id="match_invoice_payments",
    trigger=inngest.TriggerEvent(event=MATCH_INVOICES_EVENT),
    # One pass per business at a time: two would try to link the same invoices.
    concurrency=[inngest.Concurrency(limit=1, key="event.data.entity_id")],
    retries=2,
)
async def match_invoice_payments(ctx: inngest.Context) -> Dict[str, Any]:
    """Match a business's (``entity_id``) unlinked uploads to their payments."""
    # Imported here: the service imports the invoice service, which loads the journal
    # service; keeping this module light keeps function registration cheap.
    from ...services.invoice_matching import match_unlinked

    entity_id = dict(ctx.event.data).get("entity_id")
    if not entity_id:
        raise inngest.NonRetriableError("entity_id is required")

    async def _match() -> Dict[str, int]:
        return await match_unlinked(UUID(str(entity_id)))

    result = await ctx.step.run("match-unlinked-invoices", _match)
    ctx.logger.info(f"Invoice matching for {entity_id}: {result}")
    return {"status": "completed", "entity_id": str(entity_id), **result}


INVOICE_MATCHING_FUNCTIONS = [match_invoice_payments]
