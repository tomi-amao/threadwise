"""Revolut Business sign-in (integrations/revolut/oauth.py and the /oauth/revolut routes).

No network: Revolut's token endpoint is a mock transport or a stub, and the routes run with the
sync service replaced by an in-memory fake (as in test_merchant_key_routes.py).
"""

import asyncio
import base64
import json
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from ai_agent.api.routes import oauth as routes
from ai_agent.core.auth import AuthenticatedUser
from ai_agent.core.config import settings
from ai_agent.integrations.revolut import RevolutAdapter, oauth
from ai_agent.services import source_access

ENTITY = "e-1"
OTHER = "e-2"
CLIENT_ID = "abc_DEF-123"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope="module")
def key_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")


@pytest.fixture(autouse=True)
def configured(monkeypatch, key_pem):
    monkeypatch.setattr(settings, "revolut_private_key", key_pem)
    monkeypatch.setattr(settings, "revolut_redirect_uri", "")
    monkeypatch.setattr(settings, "frontend_url", "https://app.example.com")
    monkeypatch.setattr(settings, "revolut_consent_url", "https://business.revolut.com")
    oauth._access_tokens.clear()
    yield
    oauth._access_tokens.clear()


def public_key(pem: str):
    return serialization.load_pem_private_key(pem.encode(), None).public_key()


# ---------------------------------------------------------------------------
# Configuration, certificate, client assertion
# ---------------------------------------------------------------------------


class TestConfig:
    def test_redirect_uri_defaults_to_the_app_callback(self):
        assert (
            oauth.redirect_uri()
            == "https://app.example.com/api/integrations/revolut/callback"
        )
        assert oauth.issuer() == "app.example.com"

    def test_unconfigured_server_offers_nothing(self, monkeypatch):
        monkeypatch.setattr(settings, "revolut_private_key", "")
        assert not oauth.configured()
        with pytest.raises(oauth.RevolutOAuthError):
            oauth.client_assertion(CLIENT_ID)

    def test_env_style_escaped_newlines_are_accepted(self, monkeypatch, key_pem):
        monkeypatch.setattr(
            settings, "revolut_private_key", key_pem.replace("\n", "\\n")
        )
        assert oauth.client_assertion(CLIENT_ID)

    def test_a_short_key_is_refused(self, monkeypatch):
        small = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        pem = small.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        monkeypatch.setattr(settings, "revolut_private_key", pem)
        with pytest.raises(oauth.RevolutOAuthError, match="2048"):
            oauth.client_assertion(CLIENT_ID)

    def test_certificate_holds_the_servers_public_key_only(self, key_pem):
        pem = oauth.certificate_pem()
        assert "PRIVATE" not in pem
        cert = x509.load_pem_x509_certificate(pem.encode())
        assert (
            cert.public_key().public_numbers() == public_key(key_pem).public_numbers()
        )

    def test_client_assertion_is_rs256_with_revoluts_claims(self, key_pem):
        token = oauth.client_assertion(CLIENT_ID)
        assert jwt.get_unverified_header(token)["alg"] == "RS256"
        claims = jwt.decode(
            token,
            public_key(key_pem),
            algorithms=["RS256"],
            audience="https://revolut.com",
        )
        assert claims["iss"] == "app.example.com"
        assert claims["sub"] == CLIENT_ID
        assert 0 < claims["exp"] - time.time() <= oauth.ASSERTION_TTL_SECONDS

    def test_client_ids_are_checked_before_they_reach_a_url(self):
        assert oauth.valid_client_id(CLIENT_ID)
        for bad in ["", "a b", "x&redirect_uri=evil", "a" * 201]:
            assert not oauth.valid_client_id(bad)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


class TestState:
    def test_round_trip(self):
        state = oauth.mint_state({"entity_id": ENTITY, "client_id": CLIENT_ID})
        claims = oauth.verify_state(state)
        assert claims["entity_id"] == ENTITY and claims["client_id"] == CLIENT_ID

    def test_a_changed_payload_is_refused(self):
        state = oauth.mint_state({"entity_id": ENTITY, "client_id": CLIENT_ID})
        payload, signature = state.split(".")
        forged = json.dumps({"entity_id": OTHER, "client_id": CLIENT_ID, "exp": 9e9})
        forged_b64 = base64.urlsafe_b64encode(forged.encode()).decode().rstrip("=")
        with pytest.raises(oauth.RevolutOAuthError, match="signature"):
            oauth.verify_state(f"{forged_b64}.{signature}")

    def test_expired_state_is_refused(self, monkeypatch):
        state = oauth.mint_state({"entity_id": ENTITY, "client_id": CLIENT_ID})
        later = time.time() + oauth.STATE_TTL_SECONDS + 1
        monkeypatch.setattr(oauth.time, "time", lambda: later)
        with pytest.raises(oauth.RevolutOAuthError, match="too long"):
            oauth.verify_state(state)

    def test_state_signed_with_another_key_is_refused(self, monkeypatch):
        state = oauth.mint_state({"entity_id": ENTITY, "client_id": CLIENT_ID})
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        monkeypatch.setattr(
            settings,
            "revolut_private_key",
            other.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode(),
        )
        with pytest.raises(oauth.RevolutOAuthError):
            oauth.verify_state(state)

    def test_authorize_url_asks_for_read_only(self):
        url = oauth.build_authorize_url(CLIENT_ID, "s.t")
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        assert parsed.netloc == "business.revolut.com" and parsed.path == "/app-confirm"
        assert query["scope"] == ["READ"]
        assert query["response_type"] == ["code"]
        assert query["client_id"] == [CLIENT_ID]
        assert query["state"] == ["s.t"]
        assert query["redirect_uri"] == [oauth.redirect_uri()]


# ---------------------------------------------------------------------------
# Token requests and the access-token cache
# ---------------------------------------------------------------------------


def mock_revolut(monkeypatch, handler):
    real = httpx.AsyncClient

    def client(**kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("transport", None)
        return real(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(oauth.httpx, "AsyncClient", client)


class TestTokens:
    def test_code_exchange_sends_a_signed_assertion(self, monkeypatch, key_pem):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(
                {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            )
            return httpx.Response(
                200,
                json={"access_token": "a1", "refresh_token": "r1", "expires_in": 2399},
            )

        mock_revolut(monkeypatch, handler)
        tokens = run(oauth.exchange_code("the-code", CLIENT_ID))
        assert tokens["refresh_token"] == "r1"
        assert seen["grant_type"] == "authorization_code"
        assert seen["code"] == "the-code"
        assert seen["client_id"] == CLIENT_ID
        assert seen["client_assertion_type"].endswith("jwt-bearer")
        jwt.decode(
            seen["client_assertion"],
            public_key(key_pem),
            algorithms=["RS256"],
            audience="https://revolut.com",
        )

    def test_a_refused_refresh_is_marked_refused(self, monkeypatch):
        mock_revolut(
            monkeypatch,
            lambda r: httpx.Response(400, json={"error": "invalid_grant"}),
        )
        with pytest.raises(oauth.RevolutOAuthError) as caught:
            run(oauth.refresh("r1", CLIENT_ID))
        assert caught.value.refused

    def test_a_server_error_is_not_a_refusal(self, monkeypatch):
        mock_revolut(monkeypatch, lambda r: httpx.Response(503, text="down"))
        with pytest.raises(oauth.RevolutOAuthError) as caught:
            run(oauth.refresh("r1", CLIENT_ID))
        assert not caught.value.refused

    def test_access_tokens_are_cached_until_near_expiry(self, monkeypatch):
        calls = []

        async def fake_refresh(refresh_token, client_id):
            calls.append(refresh_token)
            return {"access_token": f"a{len(calls)}", "expires_in": 2399}

        monkeypatch.setattr(oauth, "refresh", fake_refresh)
        creds = {"client_id": CLIENT_ID, "refresh_token": "r1"}
        assert run(oauth.access_token_for(creds)) == "a1"
        assert run(oauth.access_token_for(creds)) == "a1"
        later = time.time() + 2399 - oauth.REFRESH_BUFFER_SECONDS + 1
        monkeypatch.setattr(oauth.time, "time", lambda: later)
        assert run(oauth.access_token_for(creds)) == "a2"
        assert calls == ["r1", "r1"]

    def test_a_rotated_refresh_token_is_handed_back_to_store(self, monkeypatch):
        async def fake_refresh(refresh_token, client_id):
            return {"access_token": "a1", "refresh_token": "r2", "expires_in": 2399}

        monkeypatch.setattr(oauth, "refresh", fake_refresh)
        stored = []

        async def keep(new):
            stored.append(json.loads(new))

        creds = {"client_id": CLIENT_ID, "refresh_token": "r1"}
        assert run(oauth.access_token_for(creds, keep)) == "a1"
        assert stored == [
            {"auth": "oauth", "client_id": CLIENT_ID, "refresh_token": "r2"}
        ]

    def test_stored_credentials_and_pasted_tokens_are_told_apart(self):
        creds = oauth.credentials_json(CLIENT_ID, "r1")
        assert oauth.parse_credentials(creds) == {
            "client_id": CLIENT_ID,
            "refresh_token": "r1",
        }
        assert oauth.parse_credentials("oa_prod_pasted_token") is None
        assert oauth.parse_credentials('{"client_id": "x"}') is None


class TestAdapterAndCheck:
    def test_adapter_uses_a_minted_token_for_a_sign_in(self, monkeypatch):
        async def fake_refresh(refresh_token, client_id):
            return {"access_token": "minted", "expires_in": 2399}

        monkeypatch.setattr(oauth, "refresh", fake_refresh)
        adapter = RevolutAdapter(api_key=oauth.credentials_json(CLIENT_ID, "r1"))
        headers = run(adapter._auth_headers())
        assert headers["Authorization"] == "Bearer minted"

    def test_adapter_still_takes_a_pasted_token(self):
        headers = run(RevolutAdapter(api_key="pasted")._auth_headers())
        assert headers["Authorization"] == "Bearer pasted"

    def test_check_says_reconnect_when_the_sign_in_is_refused(self, monkeypatch):
        async def refused(refresh_token, client_id):
            raise oauth.RevolutOAuthError("no", code="invalid_grant")

        monkeypatch.setattr(oauth, "refresh", refused)
        ok, message = run(
            source_access.check_revolut(oauth.credentials_json(CLIENT_ID, "r1"))
        )
        assert ok is False and "reconnect" in (message or "").lower()

    def test_check_knows_nothing_when_revolut_does_not_answer(self, monkeypatch):
        async def down(refresh_token, client_id):
            raise oauth.RevolutOAuthError("timeout")

        monkeypatch.setattr(oauth, "refresh", down)
        ok, _ = run(
            source_access.check_revolut(oauth.credentials_json(CLIENT_ID, "r1"))
        )
        assert ok is None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


class FakeSync:
    def __init__(self, sources):
        self.sources = {s["id"]: dict(s) for s in sources}
        self.keys: dict = {}

    async def get_external_source(self, source_id):
        return self.sources.get(source_id)

    async def get_api_key(self, source_id):
        return self.keys.get(source_id)

    async def create_external_source(
        self, entity_id, provider, external_account_id, credentials, display_name=None
    ):
        row = {
            "id": f"src-{len(self.sources) + 1}",
            "entity_id": entity_id,
            "provider": provider,
            "external_account_id": external_account_id,
            "display_name": display_name,
        }
        self.sources[row["id"]] = row
        self.keys[row["id"]] = credentials["api_key"]
        return row

    async def update_api_key(self, source_id, api_key):
        self.keys[source_id] = api_key
        return True

    async def update_api_key_status(self, source_id, status, error=None):
        self.sources[source_id]["api_key_status"] = status

    async def set_auth_method(self, source_id, method):
        self.sources[source_id]["auth_method"] = method


def user(entity=ENTITY):
    return AuthenticatedUser(
        user_id="u-1", email=None, entity_id=entity, access_token="t"
    )


@pytest.fixture
def world(monkeypatch):
    fake = FakeSync(
        [
            {"id": "rev", "entity_id": ENTITY, "provider": "revolut"},
            {"id": "shop", "entity_id": ENTITY, "provider": "shopify"},
            {"id": "theirs", "entity_id": OTHER, "provider": "revolut"},
        ]
    )
    monkeypatch.setattr(routes, "sync_service", fake)

    async def owned(u, table, record_id, column="id"):
        row = fake.sources.get(record_id)
        if not row or row["entity_id"] != u.entity_id:
            raise HTTPException(404, "Not found")

    monkeypatch.setattr(routes, "assert_owned", owned)

    async def exchange(code, client_id):
        if code == "bad":
            raise oauth.RevolutOAuthError("no", code="invalid_grant")
        return {"access_token": "a1", "refresh_token": "r1", "expires_in": 2399}

    monkeypatch.setattr(oauth, "exchange_code", exchange)

    async def can_read(token):
        return True

    monkeypatch.setattr(routes, "_can_read_accounts", can_read)
    return fake


def authorize(**body):
    return run(
        routes.revolut_authorize_url(routes.RevolutConnectRequest(**body), user())
    )


def exchange(state, code="good", as_user=None):
    return run(
        routes.revolut_exchange(
            routes.RevolutExchangeRequest(code=code, state=state), as_user or user()
        )
    )


def reason(caught) -> str:
    return caught.value.detail["reason"]


class TestRoutes:
    def test_upgrading_an_existing_integration_keeps_it(self, world):
        started = authorize(client_id=CLIENT_ID, source_id="rev")
        result = exchange(started["state"])
        assert result == {"status": "connected", "source_id": "rev", "upgraded": True}
        assert len(world.sources) == 3  # no new integration
        assert oauth.parse_credentials(world.keys["rev"]) == {
            "client_id": CLIENT_ID,
            "refresh_token": "r1",
        }
        assert world.sources["rev"]["api_key_status"] == "valid"
        assert world.sources["rev"]["auth_method"] == "oauth"

    def test_a_reconnect_reuses_the_stored_client_id(self, world):
        world.keys["rev"] = oauth.credentials_json(CLIENT_ID, "r0")
        started = authorize(source_id="rev")
        assert oauth.verify_state(started["state"])["client_id"] == CLIENT_ID

    def test_a_pasted_token_has_no_client_id_to_reuse(self, world):
        world.keys["rev"] = "pasted"
        with pytest.raises(HTTPException) as caught:
            authorize(source_id="rev")
        assert reason(caught) == "invalid_client_id"

    def test_a_new_integration_needs_its_business_id(self, world):
        with pytest.raises(HTTPException) as caught:
            authorize(client_id=CLIENT_ID)
        assert reason(caught) == "missing_account"

        started = authorize(client_id=CLIENT_ID, external_account_id="biz-9")
        result = exchange(started["state"])
        row = world.sources[result["source_id"]]
        assert row["provider"] == "revolut" and row["entity_id"] == ENTITY
        assert row["external_account_id"] == "biz-9"

    def test_someone_elses_integration_cannot_be_upgraded(self, world):
        with pytest.raises(HTTPException) as caught:
            authorize(client_id=CLIENT_ID, source_id="theirs")
        assert caught.value.status_code == 404

    def test_only_a_revolut_integration_can_be_upgraded(self, world):
        with pytest.raises(HTTPException) as caught:
            authorize(client_id=CLIENT_ID, source_id="shop")
        assert caught.value.status_code == 404

    def test_a_malformed_client_id_is_refused(self, world):
        with pytest.raises(HTTPException) as caught:
            authorize(client_id="x&scope=PAY", source_id="rev")
        assert reason(caught) == "invalid_client_id"

    def test_a_state_for_another_business_is_refused(self, world):
        started = authorize(client_id=CLIENT_ID, source_id="rev")
        with pytest.raises(HTTPException) as caught:
            exchange(started["state"], as_user=user(OTHER))
        assert caught.value.status_code == 403
        assert "rev" not in world.keys

    def test_a_forged_state_is_refused(self, world):
        with pytest.raises(HTTPException) as caught:
            exchange("bm90.aXQ")
        assert reason(caught) == "invalid_state"

    def test_a_refused_code_stores_nothing(self, world):
        started = authorize(client_id=CLIENT_ID, source_id="rev")
        with pytest.raises(HTTPException) as caught:
            exchange(started["state"], code="bad")
        assert reason(caught) == "token_exchange_failed"
        assert world.keys == {}

    def test_unconfigured_server_says_so(self, world, monkeypatch):
        monkeypatch.setattr(settings, "revolut_private_key", "")
        assert run(routes.revolut_setup()) == {
            "configured": False,
            "redirect_uri": None,
        }
        with pytest.raises(HTTPException) as caught:
            authorize(client_id=CLIENT_ID, source_id="rev")
        assert caught.value.status_code == 503
