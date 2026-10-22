"""Identifiers that are safe to put in traces and logs.

Run and thread metadata flows into LangSmith traces and the turn log. Neither should
carry a raw user or business id, so both go through `pseudonym`: a keyed hash
(HMAC-SHA256), stable for one id (so a trace can be found and a thread filtered to its
owner) but not reversible without the key. Set `TRACE_HASH_SALT` in production; changing
it makes every existing thread unreachable by its owner, so treat it like a database
key, not a toggle.
"""

import hashlib
import hmac

from .config import settings

# Only used when no salt is configured (local development and tests).
_DEV_SALT = "threadwise-development-only"


def pseudonym(value: str, purpose: str = "id") -> str:
    """A stable, non-reversible stand-in for an id. `purpose` keeps the kinds apart."""
    key = (settings.trace_hash_salt or _DEV_SALT).encode()
    digest = hmac.new(key, f"{purpose}:{value}".encode(), hashlib.sha256)
    return digest.hexdigest()[:32]
