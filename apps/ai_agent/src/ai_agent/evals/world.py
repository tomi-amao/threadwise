"""The seeded test world the golden set is written against.

The e2e seed (`pnpm db:fresh`) creates one business with known totals, writes them to a
manifest, and creates a second "rival" business. The golden set takes its expected figures
from that manifest, and the users from the database, so nothing here is invented.

Evals only ever run against a local database: the figures are only right for the seed.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import psycopg2  # type: ignore[import-untyped]

REPO = Path(__file__).resolve().parents[5]
DEFAULT_MANIFEST = REPO / "apps" / "chat-ui" / "e2e" / ".seed-manifest.json"
LOCAL_DATABASE = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal"}


class NotALocalDatabase(RuntimeError):
    """Evals compare against seeded figures, so they refuse any other database."""


@dataclass
class World:
    manifest: dict[str, Any]
    users: dict[str, dict[str, str]]  # "a" and "b": {identity, entity_id, name}
    ids: dict[str, str]  # records the page-context cases point at
    database_url: str

    def tokens_for(self, tenant: str) -> list[str]:
        """Names only the *other* business has: seeing one in an answer is a leak."""
        m = self.manifest
        if tenant == "a":
            r = m["rival"]
            return [
                r["entityName"],
                *r["orderNumbers"],
                *r["customerNames"],
                r["productName"],
                r["inventorySku"],
                r["invoiceNumber"],
                r["bankName"],
            ]
        inv, products, customers = m["invoices"], m["products"], m["customerStats"]
        return [
            m["entityName"],
            customers["topSpender"],
            customers["oneTimeName"],
            customers["lapsedName"],
            customers["neverName"],
            products["topName"],
            products["slowingName"],
            *products["neverNames"],
            inv["counterparty"],
            inv["openSale"],
            inv["overdueSale"],
            inv["overduePurchase"],
        ]


def require_local(database_url: str) -> None:
    host = urlparse(database_url).hostname or ""
    if host not in LOCAL_HOSTS:
        raise NotALocalDatabase(
            f"Evals run against the seeded local database only; '{host}' is not local."
        )


def load_world(
    database_url: str = LOCAL_DATABASE, manifest_path: Path | None = None
) -> World:
    require_local(database_url)
    path = manifest_path or DEFAULT_MANIFEST
    if not path.exists():
        raise FileNotFoundError(f"No seed manifest at {path}: run `pnpm db:fresh`.")
    manifest = json.loads(path.read_text())
    conn = psycopg2.connect(database_url, connect_timeout=3)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "select name, owner_user_id::text, id::text from entities "
                "where name = any(%s) and owner_user_id is not null",
                ([manifest["entityName"], manifest["rival"]["entityName"]],),
            )
            by_name = {n: {"identity": o, "entity_id": e} for n, o, e in cur.fetchall()}
            if len(by_name) != 2:
                raise RuntimeError(
                    "Both seeded businesses are needed: `pnpm db:fresh`."
                )
            a = by_name[manifest["entityName"]]
            cur.execute(
                "select id::text from invoices "
                "where entity_id = %s and invoice_number = %s",
                (a["entity_id"], manifest["invoices"]["openSale"]),
            )
            open_sale = cur.fetchone()[0]
            cur.execute(
                "select id::text from financial_transactions where entity_id = %s "
                "order by occurred_at desc limit 1",
                (a["entity_id"],),
            )
            transaction = cur.fetchone()[0]
    finally:
        conn.close()
    return World(
        manifest=manifest,
        users={"a": a, "b": by_name[manifest["rival"]["entityName"]]},
        ids={"open_sale": open_sale, "transaction": transaction},
        database_url=database_url,
    )


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
