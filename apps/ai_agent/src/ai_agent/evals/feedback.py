"""The review queue: answers people rated thumbs-down, newest first.

    poetry run python -m ai_agent.evals.feedback [--limit 50] [--since 2026-10-01]

Reads `assistant_feedback` with the service role (a person can only ever read their own
ratings). Each row is ids only: the business as the same hash the traces carry, the thread
and the message. Open the thread's trace (filter on `thread_id`, or group by the business
hash) to see what was asked and answered: that is how a conversation is reviewed without
anyone's data being copied into a spreadsheet.
"""

import argparse
import json
import sys
from typing import Any

from ..core.supabase_client import get_supabase_client
from ..core.tracing import pseudonym


def fetch_thumbs_down(
    client: Any, limit: int = 50, since: str | None = None
) -> list[dict[str, Any]]:
    query = (
        client.table("assistant_feedback")
        .select("entity_id, thread_id, message_id, created_at")
        .eq("rating", "down")
        .order("created_at", desc=True)
        .limit(limit)
    )
    if since:
        query = query.gte("created_at", since)
    return [
        {
            "when": row["created_at"],
            "business": pseudonym(str(row["entity_id"]), "entity"),
            "thread_id": row["thread_id"],
            "message_id": row["message_id"],
        }
        for row in query.execute().data or []
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ai_agent.evals.feedback")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--since", default=None, help="only ratings from this date on")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    client = get_supabase_client()
    if client is None:
        print(
            "Supabase is not configured (SUPABASE_URL, SUPABASE_KEY).", file=sys.stderr
        )
        return 2
    rows = fetch_thumbs_down(client, args.limit, args.since)
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        for r in rows:
            print(f"{r['when'][:19]}  {r['business'][:10]}  thread {r['thread_id']}")
        print(f"\n{len(rows)} thumbs-down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
