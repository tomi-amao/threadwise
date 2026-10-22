"""LangGraph server authentication (registered under `auth` in langgraph.json).

Every request to the LangGraph API must carry a Supabase user access token. The
business is looked up here, on the server, and stored on the user; threads and
runs are then filtered to their owner, so one user can never list, read or
continue another user's thread.
"""

from typing import Any, cast

from langgraph_sdk import Auth

from ai_agent.core.auth import AuthError, authenticate_bearer
from ai_agent.core.config import settings
from ai_agent.core.rate_limit import SlidingWindowLimiter
from ai_agent.core.tracing import pseudonym

auth = Auth()

# How fast one user may start runs (a question, an approval and a clarifying answer each
# start one). Per process; see core/rate_limit.py.
run_limiter = SlidingWindowLimiter(
    settings.assistant_runs_per_window, settings.assistant_rate_window_s
)


def owner_key(identity: str) -> str:
    """What a thread or run is stamped with: the user's id, not in the clear.

    Run metadata flows into traces, so the raw Supabase user id never goes in it.
    """
    return pseudonym(identity, "owner")


@auth.authenticate
async def authenticate(authorization: str | None) -> Auth.types.MinimalUserDict:
    try:
        user = await authenticate_bearer(authorization)
    except AuthError as exc:
        raise Auth.exceptions.HTTPException(status_code=401, detail=str(exc)) from exc
    if user.entity_id is None:
        raise Auth.exceptions.HTTPException(
            status_code=403, detail="No business set up yet"
        )
    return {
        "identity": user.user_id,
        "email": user.email or "",
        "entity_id": user.entity_id,
        "access_token": user.access_token,
        "permissions": ["threads:read", "threads:write", "runs:create"],
    }  # type: ignore[typeddict-unknown-key]


@auth.on.store
async def scope_store_to_user(
    ctx: Auth.types.AuthContext, value: dict[str, Any]
) -> None:
    """The store holds what the assistant remembers: each user reaches only their own.

    Every item's namespace starts with the user's id. A client that names another
    user's namespace gets it nested under its own, so it only ever reads and writes its
    own items.
    """
    namespace = tuple(value["namespace"]) if value.get("namespace") else ()
    if not namespace or namespace[0] != ctx.user.identity:
        namespace = (ctx.user.identity, *namespace)
    value["namespace"] = namespace


@auth.on
async def scope_to_owner(ctx: Auth.types.AuthContext, value: dict) -> dict:
    """Stamp new resources with their owner and only ever show a user their own."""
    owner = {"owner": owner_key(ctx.user.identity)}
    metadata = value.setdefault("metadata", {}) if isinstance(value, dict) else {}
    metadata.update(owner)
    return owner


@auth.on.threads.create_run
async def limit_and_scope_runs(
    ctx: Auth.types.AuthContext, value: Auth.types.RunsCreate
) -> dict:
    """Starting a run: slow a user asking too fast, then scope it like any resource.

    The run also carries a hashed business id, so traces can be grouped by business
    without naming one.
    """
    wait = run_limiter.hit(ctx.user.identity)
    if wait is not None:
        raise Auth.exceptions.HTTPException(
            status_code=429,
            detail=f"You are asking too fast. Try again in {_how_long(wait)}.",
            headers={"Retry-After": str(wait)},
        )
    fields: dict[str, Any] = cast(dict[str, Any], value)
    owner = await scope_to_owner(ctx, fields)
    entity_id = _field(ctx.user, "entity_id")
    if entity_id:
        fields.setdefault("metadata", {})["entity_hash"] = pseudonym(
            str(entity_id), "entity"
        )
    return owner


def _how_long(seconds: int) -> str:
    if seconds <= 90:
        return f"{seconds} seconds"
    minutes = round(seconds / 60)
    return f"{minutes} minutes"


def _field(user: Any, name: str) -> Any:
    """A field the authenticate handler returned (the server gives a dict-like proxy)."""
    getter = getattr(user, "get", None)
    return getter(name) if callable(getter) else getattr(user, name, None)
