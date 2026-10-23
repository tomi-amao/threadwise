"""Token verification and the LangGraph auth handler."""

import time
from unittest.mock import patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from langgraph_sdk import Auth

from ai_agent import auth as langgraph_auth
from ai_agent.core import auth as core_auth

KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


class _SigningKey:
    key = KEY.public_key()


class _FakeJwks:
    def get_signing_key_from_jwt(self, _token: str) -> _SigningKey:
        return _SigningKey()


def _token(key=KEY, **overrides) -> str:
    claims = {
        "sub": "user-1",
        "email": "a@example.test",
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 600,
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": "k"})


@pytest.fixture(autouse=True)
def _jwks_and_entities():
    core_auth._entity_cache.clear()
    with (
        patch.object(core_auth, "_jwks_client", lambda: _FakeJwks()),
        patch.object(
            core_auth,
            "_lookup_entity_id",
            lambda user_id: {"user-1": "entity-1"}.get(user_id),
        ),
    ):
        yield


def test_valid_token_returns_the_user_and_their_business():
    import asyncio

    user = asyncio.run(core_auth.authenticate_bearer(f"Bearer {_token()}"))
    assert (user.user_id, user.entity_id) == ("user-1", "entity-1")


@pytest.mark.parametrize(
    "header",
    [None, "", "Basic abc", "Bearer", "Bearer not.a.jwt"],
)
def test_missing_or_malformed_header_is_rejected(header):
    import asyncio

    with pytest.raises(core_auth.AuthError):
        asyncio.run(core_auth.authenticate_bearer(header))


@pytest.mark.parametrize(
    "token",
    [
        _token(OTHER_KEY),  # signed by someone else
        _token(exp=int(time.time()) - 5),  # expired
        _token(aud="other"),  # wrong audience
        _token(role="anon"),  # not a user token
    ],
    ids=["wrong-key", "expired", "wrong-audience", "anon-role"],
)
def test_bad_tokens_are_rejected(token):
    with pytest.raises(core_auth.AuthError):
        core_auth.verify_access_token(token)


def test_hs256_is_refused_unless_a_legacy_secret_is_configured():
    forged = jwt.encode(
        {
            "sub": "user-1",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 60,
        },
        "anything",
        algorithm="HS256",
    )
    with pytest.raises(core_auth.AuthError):
        core_auth.verify_access_token(forged)


def test_alg_none_is_refused():
    token = jwt.encode(
        {
            "sub": "user-1",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 60,
        },
        None,
        algorithm="none",
    )
    with pytest.raises(core_auth.AuthError):
        core_auth.verify_access_token(token)


def test_user_without_a_business_gets_403():
    import asyncio

    with pytest.raises(Auth.exceptions.HTTPException) as err:
        asyncio.run(langgraph_auth.authenticate(f"Bearer {_token(sub='user-2')}"))
    assert err.value.status_code == 403


def test_langgraph_handler_rejects_no_token_with_401():
    import asyncio

    with pytest.raises(Auth.exceptions.HTTPException) as err:
        asyncio.run(langgraph_auth.authenticate(None))
    assert err.value.status_code == 401


def test_threads_are_stamped_with_and_filtered_by_the_owner():
    import asyncio

    ctx = type("Ctx", (), {"user": type("U", (), {"identity": "user-1"})()})()
    value: dict = {}
    result = asyncio.run(langgraph_auth.scope_to_owner(ctx, value))
    owner = langgraph_auth.owner_key("user-1")
    assert result == {"owner": owner}
    assert value["metadata"]["owner"] == owner
    assert (
        "user-1" not in owner
    )  # the raw id never goes into metadata, and so not traces


# ── limits and what goes into traces ─────────────────────────────────────────────────


def _ctx(identity="user-1", entity_id="entity-1"):
    user = {"identity": identity, "entity_id": entity_id}
    return type(
        "Ctx", (), {"user": type("U", (), {"identity": identity, "get": user.get})()}
    )()


def test_a_user_asking_too_fast_is_told_to_wait_not_cut_off_for_good():
    import asyncio

    from ai_agent.core.rate_limit import SlidingWindowLimiter

    clock = [1000.0]
    limiter = SlidingWindowLimiter(3, 60, clock=lambda: clock[0])
    with patch.object(langgraph_auth, "run_limiter", limiter):
        for _ in range(3):
            asyncio.run(langgraph_auth.limit_and_scope_runs(_ctx(), {}))
        with pytest.raises(Auth.exceptions.HTTPException) as err:
            asyncio.run(langgraph_auth.limit_and_scope_runs(_ctx(), {}))
        assert err.value.status_code == 429
        assert err.value.headers == {"Retry-After": "60"}
        assert "60 seconds" in str(err.value.detail)
        assert langgraph_auth._how_long(598) == "10 minutes"
        # One user's limit is not another's, and the window moves on.
        asyncio.run(langgraph_auth.limit_and_scope_runs(_ctx("user-2"), {}))
        clock[0] += 61
        asyncio.run(langgraph_auth.limit_and_scope_runs(_ctx(), {}))


def test_the_limiter_counts_a_sliding_window():
    from ai_agent.core.rate_limit import SlidingWindowLimiter

    now = [0.0]
    limiter = SlidingWindowLimiter(2, 10, clock=lambda: now[0])
    assert limiter.hit("u") is None
    now[0] = 4
    assert limiter.hit("u") is None
    now[0] = 5
    assert limiter.hit("u") == 5  # the first request leaves the window at t=10
    now[0] = 10
    assert limiter.hit("u") is None  # now it has


def test_runs_carry_a_hashed_business_and_owner_never_the_raw_ids():
    import asyncio

    value: dict = {}
    asyncio.run(
        langgraph_auth.limit_and_scope_runs(
            _ctx("user-secret-1", "entity-secret-1"), value
        )
    )
    metadata = value["metadata"]
    assert set(metadata) == {"owner", "entity_hash"}
    assert "secret" not in json_text(metadata)
    # Stable: the same business always hashes the same, so traces can be grouped by it.
    again: dict = {}
    asyncio.run(
        langgraph_auth.limit_and_scope_runs(
            _ctx("user-secret-1", "entity-secret-1"), again
        )
    )
    assert again["metadata"] == metadata
    other: dict = {}
    asyncio.run(langgraph_auth.limit_and_scope_runs(_ctx("user-x", "entity-x"), other))
    assert other["metadata"]["entity_hash"] != metadata["entity_hash"]


def json_text(value) -> str:
    import json

    return json.dumps(value)


def test_a_different_salt_gives_different_pseudonyms():
    from ai_agent.core import tracing

    with patch.object(tracing.settings, "trace_hash_salt", "one"):
        first = tracing.pseudonym("abc", "owner")
    with patch.object(tracing.settings, "trace_hash_salt", "two"):
        second = tracing.pseudonym("abc", "owner")
    assert first != second and len(first) == 32
    assert tracing.pseudonym("abc", "owner") != tracing.pseudonym("abc", "entity")
