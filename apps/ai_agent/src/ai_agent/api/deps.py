"""Who is calling a REST route, and which business they may touch.

Every route in `api/routes` is protected by one of these dependencies, applied on its
router:

- `current_user`  - a signed-in user (Supabase access token, `Authorization: Bearer`).
- `entity_guard`  - `current_user`, plus: any `entity_id` the request names (query,
                    path, JSON body or form field) must be the caller's own business.
- `require_internal` - machine callers (scripts, operators) holding `INTERNAL_API_KEY`.

Routes that name a record by id alone (a source, an invoice, a journal) also check that
the record belongs to the caller: `assert_owned`, wrapped as `owned_*` dependencies.
Missing and not-yours both answer 404, so ids cannot be probed.
"""

import asyncio
import hmac
import logging
from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, Request, status

from ai_agent.core.auth import AuthenticatedUser, AuthError, authenticate_bearer
from ai_agent.core.config import settings
from ai_agent.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


async def current_user(
    request: Request, authorization: Annotated[str | None, Header()] = None
) -> AuthenticatedUser:
    """The verified caller: 401 without a valid token, 403 with no business yet."""
    cached = getattr(request.state, "user", None)
    if cached is not None:
        return cached  # type: ignore[no-any-return]
    try:
        user = await authenticate_bearer(authorization)
    except AuthError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    if user.entity_id is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No business set up yet")
    request.state.user = user
    return user


CurrentUser = Annotated[AuthenticatedUser, Depends(current_user)]


def _forbidden() -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN, "That business is not yours")


def authorize_entity(user: AuthenticatedUser, entity_id: str | None) -> str:
    """The caller's business id; 403 if `entity_id` names a different one."""
    assert user.entity_id is not None
    if entity_id is not None and str(entity_id).lower() != user.entity_id.lower():
        raise _forbidden()
    return user.entity_id


def _entity_ids_in(value: Any) -> list[str]:
    """Every `entity_id` in a JSON document, however deeply nested."""
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "entity_id" and item is not None:
                found.append(str(item))
            else:
                found.extend(_entity_ids_in(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_entity_ids_in(item))
    return found


async def entity_guard(request: Request, user: CurrentUser) -> AuthenticatedUser:
    """Reject the request if it names any business other than the caller's."""
    named: list[str] = []
    named.extend(request.query_params.getlist("entity_id"))
    if "entity_id" in request.path_params:
        named.append(str(request.path_params["entity_id"]))
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            named.extend(_entity_ids_in(await request.json()))
        except ValueError:
            pass  # the route's own validation answers 422
    elif "multipart/form-data" in content_type or "urlencoded" in content_type:
        form = await request.form()
        named.extend(str(v) for v in form.getlist("entity_id"))
    for entity_id in named:
        authorize_entity(user, entity_id)
    return user


EntityScoped = Annotated[AuthenticatedUser, Depends(entity_guard)]


async def require_internal(
    x_internal_key: Annotated[str | None, Header()] = None,
) -> None:
    """Machine callers only. With no INTERNAL_API_KEY configured, nobody gets in."""
    expected = settings.internal_api_key
    if not expected or not x_internal_key:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Internal endpoint")
    if not hmac.compare_digest(x_internal_key, expected):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Internal endpoint")


def _owner_lookup(table: str, record_id: str, column: str) -> str | None:
    client = get_supabase_client()
    if client is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Database not configured"
        )
    rows: Any = (
        client.table(table)
        .select("entity_id")
        .eq(column, record_id)
        .limit(1)
        .execute()
        .data
    )
    return str(rows[0]["entity_id"]) if rows else None


async def assert_owned(
    user: AuthenticatedUser, table: str, record_id: str, column: str = "id"
) -> None:
    """404 unless `table.column = record_id` is a row of the caller's business."""
    try:
        owner = await asyncio.to_thread(_owner_lookup, table, record_id, column)
    except HTTPException:
        raise
    except Exception as exc:  # a malformed id is the same as a missing one
        logger.info("ownership lookup on %s failed: %s", table, exc)
        owner = None
    if owner is None or owner.lower() != (user.entity_id or "").lower():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


async def owned_source(source_id: str, user: CurrentUser) -> None:
    """Route dependency: the `source_id` in the path or query is the caller's."""
    await assert_owned(user, "external_sources", source_id)


async def owned_transaction(transaction_id: str, user: CurrentUser) -> None:
    await assert_owned(user, "financial_transactions", transaction_id)


async def owned_invoice(invoice_id: str, user: CurrentUser) -> None:
    await assert_owned(user, "invoices", invoice_id)


async def owned_journal(journal_id: str, user: CurrentUser) -> None:
    await assert_owned(user, "journals", journal_id)
