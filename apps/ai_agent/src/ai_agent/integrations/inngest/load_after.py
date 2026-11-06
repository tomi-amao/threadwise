"""Load what a single-endpoint sync fetched, when a person asked for that sync.

A full sync ends by sending `<provider>/sync.completed`, which loads (normalises) what it
fetched. A sync of one endpoint did not, so the data stayed as raw events until someone
clicked Load data. The route that starts a single-endpoint sync now marks the event with
`load_after`, and the endpoint function sends the same `sync.completed` when it succeeds.

The endpoint functions are also invoked by each provider's full sync, without the mark,
so a full sync still loads once, at its end.
"""

from typing import Any, Dict

import inngest

from .config import get_client

LOAD_AFTER = "load_after"


def wants_load(event_data: Dict[str, Any]) -> bool:
    return bool(event_data.get(LOAD_AFTER))


def completed_event(
    provider: str, source_id: str, endpoint: str, items_stored: int
) -> inngest.Event:
    return inngest.Event(
        name=f"{provider}/sync.completed",
        data={
            "source_id": source_id,
            "total_items": items_stored,
            "endpoints": [endpoint],
        },
    )


async def load_after_endpoint_sync(
    ctx: inngest.Context,
    provider: str,
    source_id: str,
    endpoint: str,
    items_stored: int,
) -> bool:
    """Send `<provider>/sync.completed` if this run was asked to load. True if sent."""
    if not wants_load(dict(ctx.event.data)):
        return False
    client = get_client()
    event = completed_event(provider, source_id, endpoint, items_stored)
    await ctx.step.run("load-after-endpoint-sync", lambda: client.send(event))
    return True
