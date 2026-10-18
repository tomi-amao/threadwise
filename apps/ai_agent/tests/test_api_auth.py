"""Every REST route needs a caller, and a caller only reaches their own business.

The first test is the fail-closed one: a route added without an auth dependency fails
it, so "forgot to protect it" cannot ship.
"""

import asyncio
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from ai_agent.api import deps
from ai_agent.core import auth as core_auth
from ai_agent.core.config import settings
from ai_agent.main import app

from .test_auth import _FakeJwks, _token

# Routes anyone may call, with the reason.
PUBLIC = {
    ("GET", "/"): "welcome banner",
    ("GET", "/health"): "liveness probe, reveals nothing about configuration",
    ("GET", "/stats"): "placeholder counters",
    (
        "GET",
        "/oauth/zoho_calendar/callback",
    ): "Zoho redirects the browser here; the signed "
    "state, minted for an authenticated user, is the protection",
    ("POST", "/api/inngest"): "Inngest SDK verifies the request signature",
    ("GET", "/api/inngest"): "Inngest SDK verifies the request signature",
    ("PUT", "/api/inngest"): "Inngest SDK verifies the request signature",
}
GUARDS = {deps.current_user, deps.entity_guard, deps.require_internal}
ENTITY_1 = "11111111-1111-1111-1111-111111111111"
ENTITY_2 = "22222222-2222-2222-2222-222222222222"
OWNERS = {"user-1": ENTITY_1}


def _all_calls(route) -> set:
    """Every dependency callable a route runs, including its routers' own."""

    def walk(dependant) -> set:
        calls = {dependant.call}
        for sub in dependant.dependencies:
            calls |= walk(sub)
        return calls

    calls = walk(route.dependant)
    for declared in getattr(route, "dependencies", None) or []:
        calls.add(declared.dependency)
    return calls


def _routes():
    """(method, route) for every endpoint, however deeply its router was included.

    FastAPI nests included routers lazily (`_IncludedRouter`), so `app.routes` alone shows
    only a handful of entries; `effective_route_contexts()` is what flattens them.
    """
    seen = []
    for top in app.routes:
        if isinstance(top, APIRoute):
            seen.append(top)
        elif hasattr(top, "effective_route_contexts"):
            seen.extend(top.effective_route_contexts())
    for route in seen:
        for method in route.methods - {"HEAD", "OPTIONS"}:
            yield method, route


def _path(route: APIRoute) -> str:
    return "".join("x" if part.startswith("{") else part for part in _split(route.path))


def _split(path: str):
    import re

    return [p for p in re.split(r"(\{[^}]+\})", path) if p]


@pytest.fixture(autouse=True)
def _identity(monkeypatch):
    core_auth._entity_cache.clear()
    monkeypatch.setattr(core_auth, "_jwks_client", lambda: _FakeJwks())
    monkeypatch.setattr(core_auth, "_lookup_entity_id", lambda uid: OWNERS.get(uid))
    monkeypatch.setattr(settings, "internal_api_key", "internal-secret")


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


def _bearer(sub: str = "user-1") -> dict:
    return {"Authorization": f"Bearer {_token(sub=sub)}"}


def test_the_route_walk_sees_the_whole_api():
    # Guards against this file silently checking nothing if FastAPI changes how it nests
    # routers.
    assert len(list(_routes())) > 70


def test_every_route_has_an_auth_dependency():
    unguarded = [
        f"{method} {route.path}"
        for method, route in _routes()
        if (method, route.path) not in PUBLIC and not (_all_calls(route) & GUARDS)
    ]
    assert unguarded == []


def test_every_protected_route_refuses_an_anonymous_caller(client):
    leaks = []
    for method, route in _routes():
        if (method, route.path) in PUBLIC:
            continue
        status = client.request(method, _path(route)).status_code
        if status not in (401, 403):
            leaks.append(f"{method} {route.path} -> {status}")
    assert leaks == []


def test_a_user_token_does_not_open_internal_routes(client):
    for path in ("/inngest/health", "/embeddings/stats", "/normalization/stats"):
        assert client.get(path, headers=_bearer()).status_code == 403


def test_internal_key_opens_internal_routes_and_a_wrong_one_does_not(client):
    assert (
        client.get("/inngest/health", headers={"X-Internal-Key": "nope"}).status_code
        == 403
    )
    ok = client.get("/inngest/health", headers={"X-Internal-Key": "internal-secret"})
    assert ok.status_code == 200


def test_internal_routes_are_closed_when_no_key_is_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "internal_api_key", None)
    assert (
        client.get("/inngest/health", headers={"X-Internal-Key": ""}).status_code == 403
    )


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("GET", f"/accounting/journals?entity_id={ENTITY_2}", {}),
        ("GET", f"/accounting/invoices?entity_id={ENTITY_2}", {}),
        ("GET", f"/integrations/sources?entity_id={ENTITY_2}", {}),
        ("GET", f"/integrations/summary?entity_id={ENTITY_2}", {}),
        ("POST", "/accounting/journals/accrue", {"json": {"entity_id": ENTITY_2}}),
        (
            "POST",
            "/accounting/chart-of-accounts/seed",
            {"json": {"entity_id": ENTITY_2}},
        ),
        (
            "POST",
            "/integrations/sources",
            {"json": {"entity_id": ENTITY_2, "provider": "shopify", "api_key": "k"}},
        ),
        (
            "POST",
            "/accounting/invoices/process",
            {"data": {"entity_id": ENTITY_2, "file_path": "x"}},
        ),
    ],
)
def test_naming_someone_elses_business_is_forbidden(client, method, path, kwargs):
    response = client.request(method, path, headers=_bearer(), **kwargs)
    assert response.status_code == 403


def test_a_user_without_a_business_is_refused(client):
    assert (
        client.get("/integrations/summary", headers=_bearer("user-9")).status_code
        == 403
    )


def test_ownership_check_hides_other_businesses_records():
    user = core_auth.AuthenticatedUser("user-1", None, ENTITY_1, "t")
    with patch.object(deps, "_owner_lookup", lambda *_: ENTITY_2):
        with pytest.raises(HTTPException) as err:
            asyncio.run(deps.assert_owned(user, "invoices", "abc"))
    assert err.value.status_code == 404
    with patch.object(deps, "_owner_lookup", lambda *_: None):
        with pytest.raises(HTTPException) as err:
            asyncio.run(deps.assert_owned(user, "invoices", "abc"))
    assert err.value.status_code == 404
    with patch.object(deps, "_owner_lookup", lambda *_: ENTITY_1):
        asyncio.run(deps.assert_owned(user, "invoices", "abc"))


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/integrations/sources/abc"),
        ("DELETE", "/integrations/sources/abc"),
        ("PUT", "/integrations/transactions/abc/category"),
        ("GET", "/accounting/invoices/abc"),
        ("POST", "/accounting/journals/abc/reverse"),
        ("GET", "/realtime/channels/abc"),
    ],
)
def test_records_of_another_business_answer_404(client, method, path):
    with patch.object(deps, "_owner_lookup", lambda *_: ENTITY_2):
        response = client.request(method, path, headers=_bearer(), json={})
    assert response.status_code == 404


def test_realtime_token_for_another_business_is_refused(client):
    response = client.post(
        "/realtime/subscription-token",
        headers=_bearer(),
        json={"source_id": ENTITY_2, "channel_type": "journals"},
    )
    assert response.status_code == 403
    with patch.object(deps, "_owner_lookup", lambda *_: ENTITY_2):
        response = client.post(
            "/realtime/subscription-token",
            headers=_bearer(),
            json={"source_id": "abc", "channel_type": "sync"},
        )
    assert response.status_code == 404


def test_reprocess_needs_a_source_the_caller_owns(client):
    assert (
        client.post(
            "/normalization/reprocess-failed", headers=_bearer(), json={}
        ).status_code
        == 400
    )
    with patch.object(deps, "_owner_lookup", lambda *_: ENTITY_2):
        response = client.post(
            "/normalization/reprocess-failed",
            headers=_bearer(),
            json={"source_id": "abc"},
        )
    assert response.status_code == 404
