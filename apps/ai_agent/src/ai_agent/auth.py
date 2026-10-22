"""LangGraph server authentication (registered under `auth` in langgraph.json).

Every request to the LangGraph API must carry a Supabase user access token. The
business is looked up here, on the server, and stored on the user; threads and
runs are then filtered to their owner, so one user can never list, read or
continue another user's thread.
"""

from typing import Any

from langgraph_sdk import Auth

from ai_agent.core.auth import AuthError, authenticate_bearer

auth = Auth()


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
    owner = {"owner": ctx.user.identity}
    metadata = value.setdefault("metadata", {}) if isinstance(value, dict) else {}
    metadata.update(owner)
    return owner
