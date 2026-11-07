"""Revolut Business sign-in: OAuth 2.0 authorisation code with a signed JWT client assertion.

How Revolut's Business API authenticates an app, and what each piece is here:

- **Key pair.** ThreadWise holds one RSA private key (`REVOLUT_PRIVATE_KEY`, server config only).
  A business uploads the matching certificate (`certificate_pem`, served by the app) in
  Revolut Business, Settings, APIs, Business API, and sets the redirect URI. Revolut gives that
  business a **client ID**. Nothing secret is copied by hand: the certificate is public, the
  client ID is an identifier, and the private key never leaves the server.
- **Consent.** The user is sent to Revolut's consent page (`build_authorize_url`) asking for the
  `READ` scope only: ThreadWise reads accounts, transactions and expenses and can never move
  money. Revolut redirects back with a one-time code.
- **Client assertion.** Every token request carries a short-lived JWT signed with the private key
  (`client_assertion`, RS256, `iss` = the redirect URI's host, `sub` = the client ID,
  `aud` = https://revolut.com). It replaces a client secret: there is no shared secret to leak.
- **Tokens.** The code is exchanged for an access token (about 40 minutes) and a refresh token.
  Only the client ID and refresh token are stored, as this source's Vault-encrypted key
  (`credentials_json`); access tokens are minted from them when needed and cached in memory only
  (`access_token_for`).
- **State.** The consent request carries a signed, expiring `state` (HMAC-SHA256, 10 minutes)
  naming the business, the source being upgraded and the client ID. The exchange route also
  requires the signed-in user to be that business, and the app's callback route checks the state
  against a cookie set when the flow started, so a code cannot be planted in someone else's
  browser (login CSRF) or replayed for another business.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Awaitable, Callable, Dict, Optional, cast
from urllib.parse import urlencode, urlparse

import httpx
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from ...core.config import settings

logger = logging.getLogger(__name__)

API_BASE_URL = os.environ.get("REVOLUT_API_URL", "https://b2b.revolut.com")
TOKEN_URL = f"{API_BASE_URL}/api/1.0/auth/token"
ACCOUNTS_URL = f"{API_BASE_URL}/api/1.0/accounts"

# Least privilege: read accounts, transactions and expenses. Never WRITE or PAY.
SCOPE = "READ"
CALLBACK_PATH = "/api/integrations/revolut/callback"
AUDIENCE = "https://revolut.com"
ASSERTION_TTL_SECONDS = 300
STATE_TTL_SECONDS = 600
# Mint a new access token this long before the current one expires.
REFRESH_BUFFER_SECONDS = 300
MIN_KEY_BITS = 2048
TIMEOUT = 15.0
USER_AGENT = "ThreadWise/1.0"

# OAuth error codes that mean the stored sign-in no longer works and needs the user (revoked
# access, an expired refresh token, a certificate removed in Revolut).
REFUSALS = {"invalid_grant", "invalid_client", "unauthorized_client"}

# What a Revolut client ID looks like; anything else is refused before it reaches a URL.
_CLIENT_ID = re.compile(r"^[A-Za-z0-9_\-]{1,200}$")


class RevolutOAuthError(Exception):
    """A failure in the Revolut sign-in: a bad code, a refused refresh token, bad config.

    `code` is the OAuth error Revolut answered with (`invalid_grant`, ...), or None when there was
    no usable answer, so a caller can tell "the user must reconnect" (`refused`) from "Revolut did
    not answer properly".
    """

    def __init__(self, message: str, code: Optional[str] = None):
        super().__init__(message)
        self.code = code

    @property
    def refused(self) -> bool:
        return self.code in REFUSALS


# ---------------------------------------------------------------------------
# Configuration: the key pair and the redirect URI
# ---------------------------------------------------------------------------


def configured() -> bool:
    """True when this server holds a private key, so the sign-in can be offered."""
    return bool(settings.revolut_private_key.strip())


@lru_cache(maxsize=4)
def _load_private_key(pem: str) -> rsa.RSAPrivateKey:
    try:
        key = serialization.load_pem_private_key(
            pem.replace("\\n", "\n").encode("utf-8"), password=None
        )
    except Exception as e:
        raise RevolutOAuthError(
            f"REVOLUT_PRIVATE_KEY is not a valid PEM key: {e}"
        ) from e
    if not isinstance(key, rsa.RSAPrivateKey):
        raise RevolutOAuthError("REVOLUT_PRIVATE_KEY must be an RSA key")
    if key.key_size < MIN_KEY_BITS:
        raise RevolutOAuthError(
            f"REVOLUT_PRIVATE_KEY must be at least {MIN_KEY_BITS} bits"
        )
    return key


def _private_key() -> rsa.RSAPrivateKey:
    if not configured():
        raise RevolutOAuthError("Revolut sign-in is not configured on this server")
    return _load_private_key(settings.revolut_private_key)


def redirect_uri() -> str:
    """Where Revolut sends the browser after consent (the app's callback route)."""
    return settings.revolut_redirect_uri or (
        f"{settings.frontend_url.rstrip('/')}{CALLBACK_PATH}"
    )


def issuer() -> str:
    """The JWT `iss`: the redirect URI's host, without scheme or port."""
    host = urlparse(redirect_uri()).hostname
    if not host:
        raise RevolutOAuthError(
            f"The Revolut redirect URI is not a URL: {redirect_uri()}"
        )
    return host


@lru_cache(maxsize=4)
def _certificate_for(pem: str, common_name: str) -> str:
    key = _load_private_key(pem)
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "ThreadWise"),
        ]
    )
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=5 * 365))
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


def certificate_pem() -> str:
    """The public certificate a business uploads in Revolut (self-signed, for this server's key).

    It holds only the public key. It is cached per process: any certificate for the same key
    works, so a new one after a restart does not break a connection made with an older one.
    """
    _private_key()  # the configured() check and key validation, with their messages
    return _certificate_for(settings.revolut_private_key, issuer())


def valid_client_id(client_id: str) -> bool:
    return bool(_CLIENT_ID.match(client_id))


def client_assertion(client_id: str) -> str:
    """The signed JWT that authenticates ThreadWise on a token request, for one business."""
    now = int(time.time())
    claims = {
        "iss": issuer(),
        "sub": client_id,
        "aud": AUDIENCE,
        "iat": now,
        "exp": now + ASSERTION_TTL_SECONDS,
    }
    return jwt.encode(claims, _private_key(), algorithm="RS256")


# ---------------------------------------------------------------------------
# Signed state
# ---------------------------------------------------------------------------


def _state_secret() -> bytes:
    # Derived from the private key, so no second secret to configure; a key used only as an HMAC
    # key here, never sent anywhere. The prefix keeps it distinct from any other use of the key.
    der = _private_key().private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return hashlib.sha256(b"threadwise-revolut-oauth-state\x00" + der).digest()


def _sign(payload_b64: str) -> str:
    return hmac.new(
        _state_secret(), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()


def mint_state(claims: Dict[str, Any]) -> str:
    """A signed, expiring state carrying `claims` (must include `entity_id` and `client_id`)."""
    payload = {
        **claims,
        "nonce": secrets.token_urlsafe(16),
        "exp": int(time.time()) + STATE_TTL_SECONDS,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8"))
    payload_b64 = encoded.decode("ascii").rstrip("=")
    return f"{payload_b64}.{_sign(payload_b64)}"


def verify_state(state: str) -> Dict[str, Any]:
    """The claims of a state minted by `mint_state`; RevolutOAuthError if forged or expired."""
    try:
        payload_b64, signature = state.split(".", 1)
    except ValueError as e:
        raise RevolutOAuthError("Malformed state") from e
    if not hmac.compare_digest(_sign(payload_b64), signature):
        raise RevolutOAuthError("Invalid state signature")
    try:
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
    except Exception as e:
        raise RevolutOAuthError("Malformed state payload") from e
    if not isinstance(payload, dict):
        raise RevolutOAuthError("Malformed state payload")
    if payload.get("exp", 0) < time.time():
        raise RevolutOAuthError("The sign-in took too long. Please connect again.")
    if not payload.get("entity_id") or not payload.get("client_id"):
        raise RevolutOAuthError("State is missing its business or client ID")
    return cast(Dict[str, Any], payload)


def build_authorize_url(client_id: str, state: str) -> str:
    """Revolut's consent page for this business's client ID."""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": SCOPE,
        "state": state,
    }
    return f"{settings.revolut_consent_url.rstrip('/')}/app-confirm?{urlencode(params)}"


# ---------------------------------------------------------------------------
# Token requests
# ---------------------------------------------------------------------------


async def _post_token(client_id: str, data: Dict[str, str]) -> Dict[str, Any]:
    form = {
        **data,
        "client_id": client_id,
        "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        "client_assertion": client_assertion(client_id),
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                TOKEN_URL, data=form, headers={"User-Agent": USER_AGENT}
            )
    except httpx.HTTPError as e:
        raise RevolutOAuthError(f"Revolut token request failed: {e}") from e

    try:
        payload = response.json()
    except ValueError:
        payload = None
    if response.is_success and isinstance(payload, dict):
        return cast(Dict[str, Any], payload)

    # Never log the request: it carries the code or refresh token. The error body does not.
    code = None
    description = f"HTTP {response.status_code}"
    if isinstance(payload, dict):
        code = payload.get("error") or None
        description = str(
            payload.get("error_description") or payload.get("message") or description
        )
    if code is None and response.status_code in (400, 401):
        code = "invalid_grant" if data.get("grant_type") == "refresh_token" else None
    raise RevolutOAuthError(
        f"Revolut refused the token request: {description}",
        code=str(code) if code else None,
    )


async def exchange_code(code: str, client_id: str) -> Dict[str, Any]:
    """Exchange the one-time consent code for an access token and a refresh token."""
    tokens = await _post_token(
        client_id, {"grant_type": "authorization_code", "code": code}
    )
    if not tokens.get("access_token") or not tokens.get("refresh_token"):
        raise RevolutOAuthError(
            "Revolut did not return both an access and a refresh token"
        )
    return tokens


async def refresh(refresh_token: str, client_id: str) -> Dict[str, Any]:
    """A new access token from the stored refresh token."""
    tokens = await _post_token(
        client_id, {"grant_type": "refresh_token", "refresh_token": refresh_token}
    )
    if not tokens.get("access_token"):
        raise RevolutOAuthError("Revolut's refresh answer had no access token")
    return tokens


# ---------------------------------------------------------------------------
# Stored credentials and the access-token cache
# ---------------------------------------------------------------------------


def credentials_json(client_id: str, refresh_token: str) -> str:
    """What is stored, Vault-encrypted, as this source's key."""
    return json.dumps(
        {"auth": "oauth", "client_id": client_id, "refresh_token": refresh_token}
    )


def parse_credentials(stored: str) -> Optional[Dict[str, str]]:
    """The sign-in credentials in a stored key, or None for a pasted access token."""
    text = stored.strip()
    if not text.startswith("{"):
        return None
    try:
        creds = json.loads(text)
    except json.JSONDecodeError:
        return None
    if (
        isinstance(creds, dict)
        and isinstance(creds.get("client_id"), str)
        and isinstance(creds.get("refresh_token"), str)
    ):
        return {
            "client_id": creds["client_id"],
            "refresh_token": creds["refresh_token"],
        }
    return None


# sha256(refresh token) -> (access token, expires at). In memory only, never persisted, keyed by
# a hash so the refresh token itself is not held as a dict key.
_access_tokens: Dict[str, tuple[str, float]] = {}

RotatedCallback = Callable[[str], Awaitable[None]]


def _cache_key(refresh_token: str) -> str:
    return hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()


def remember_access_token(refresh_token: str, tokens: Dict[str, Any]) -> None:
    expires_in = int(tokens.get("expires_in") or 2400)
    _access_tokens[_cache_key(refresh_token)] = (
        str(tokens["access_token"]),
        time.time() + expires_in - REFRESH_BUFFER_SECONDS,
    )


def forget_access_token(refresh_token: str) -> None:
    _access_tokens.pop(_cache_key(refresh_token), None)


async def access_token_for(
    creds: Dict[str, str], on_rotated: Optional[RotatedCallback] = None
) -> str:
    """A working access token for stored sign-in credentials, refreshed when near expiry.

    If Revolut answers a refresh with a new refresh token, `on_rotated` is called with the new
    credentials JSON so it can be stored; the old one may stop working.
    """
    refresh_token = creds["refresh_token"]
    cached = _access_tokens.get(_cache_key(refresh_token))
    if cached and cached[1] > time.time():
        return cached[0]

    tokens = await refresh(refresh_token, creds["client_id"])
    new_refresh = tokens.get("refresh_token")
    if isinstance(new_refresh, str) and new_refresh and new_refresh != refresh_token:
        forget_access_token(refresh_token)
        refresh_token = new_refresh
        if on_rotated is not None:
            await on_rotated(credentials_json(creds["client_id"], new_refresh))
        else:
            logger.warning(
                "Revolut rotated a refresh token but nothing stored the new one"
            )
    remember_access_token(refresh_token, tokens)
    return str(tokens["access_token"])


def store_rotated_for(source_id: Optional[str]) -> Optional[RotatedCallback]:
    """A callback that stores rotated credentials as `source_id`'s key, keeping it 'valid'."""
    if not source_id:
        return None

    async def _store(new_credentials: str) -> None:
        # Imported here: the sync service pulls in the Supabase client and Inngest wiring.
        from ...services.external_sync_service import sync_service

        await sync_service.update_api_key(source_id, new_credentials)
        await sync_service.update_api_key_status(source_id, "valid")

    return _store
