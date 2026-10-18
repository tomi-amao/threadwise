"""Verifying a Supabase access token and finding the business it belongs to.

Used by the LangGraph auth handler (`ai_agent/auth.py`) and, later, by FastAPI
dependencies. The token is checked locally against the project's published signing
keys (JWKS), so there is no per-request call to Supabase Auth. The business is looked
up on the server from the verified user id; nothing the client sends can choose it.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from functools import lru_cache

import jwt

from .config import settings
from .supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

# Asymmetric keys are what Supabase issues for new projects and the local stack.
# HS256 is only accepted when a legacy shared secret is configured.
_ASYMMETRIC = ["ES256", "RS256"]
_ENTITY_CACHE_SECONDS = 60.0
_entity_cache: dict[str, tuple[float, str | None]] = {}


class AuthError(Exception):
    """The token is missing, invalid or expired, or the user has no business."""


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: str
    email: str | None
    entity_id: str | None
    access_token: str


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    if not settings.supabase_url:
        raise AuthError("SUPABASE_URL is not configured")
    url = f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=600)


def verify_access_token(token: str) -> dict:
    """Return the verified claims of a Supabase user access token, or raise AuthError."""
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg")
        if alg in _ASYMMETRIC:
            key = _jwks_client().get_signing_key_from_jwt(token).key
            algorithms = _ASYMMETRIC
        elif alg == "HS256" and settings.supabase_jwt_secret:
            key = settings.supabase_jwt_secret
            algorithms = ["HS256"]
        else:
            raise AuthError("Unsupported token algorithm")
        claims = jwt.decode(
            token,
            key,
            algorithms=algorithms,
            audience="authenticated",
            options={"require": ["exp", "sub"]},
        )
    except AuthError:
        raise
    except jwt.PyJWTError as exc:
        raise AuthError(f"Invalid token: {exc}") from exc
    except Exception as exc:  # JWKS fetch failures and the like: fail closed
        logger.exception("Token verification failed")
        raise AuthError("Could not verify token") from exc
    if claims.get("role") != "authenticated":
        raise AuthError("Not a user token")
    return claims


def _lookup_entity_id(user_id: str) -> str | None:
    client = get_supabase_client()
    if client is None:
        raise AuthError("Supabase is not configured")
    rows = (
        client.table("entities")
        .select("id")
        .eq("owner_user_id", user_id)
        .order("created_at")
        .limit(1)
        .execute()
        .data
    )
    first: dict = rows[0] if rows else {}  # type: ignore[assignment]
    return str(first["id"]) if first else None


async def entity_id_for_user(user_id: str) -> str | None:
    cached = _entity_cache.get(user_id)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    entity_id = await asyncio.to_thread(_lookup_entity_id, user_id)
    _entity_cache[user_id] = (time.monotonic() + _ENTITY_CACHE_SECONDS, entity_id)
    return entity_id


async def authenticate_bearer(authorization: str | None) -> AuthenticatedUser:
    """Turn an `Authorization: Bearer <jwt>` header into a user with their business."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthError("Missing bearer token")
    token = authorization[7:].strip()
    # Fetching the signing keys is a blocking HTTP call; keep it off the event loop.
    claims = await asyncio.to_thread(verify_access_token, token)
    user_id = claims["sub"]
    return AuthenticatedUser(
        user_id=user_id,
        email=claims.get("email"),
        entity_id=await entity_id_for_user(user_id),
        access_token=token,
    )
