"""What the Summary tab's end-to-end test cannot see from the browser.

The Playwright spec fakes the agent, so three things are checked here instead:

- The fixture it answers with is what the backend really produces, and the status
  message it sends has the fields the job really publishes.
- Every status message of a run, across Inngest replays, carries one ``started_at``.
- The real query finds this run's journals and no one else's (needs the local stack).
"""

import asyncio
import copy
import inspect
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import psycopg2
import pytest
from supabase import create_client

from ai_agent.integrations.inngest import journal_generation_functions as job
from ai_agent.integrations.inngest.channels import JournalPipelineStatusData
from ai_agent.services import journal_run_summary as summary
from ai_agent.services.journal_run_summary import (
    JournalRunNarrative,
    build_run_stats,
    summarize_journal_run,
)
from ai_agent.services.journal_service import JournalService

from .test_chat_agent import LOCAL_DB
from .test_chat_agent import seed as _seed  # noqa: F401

E2E = Path(__file__).parents[2] / "chat-ui" / "e2e"
CONTRACT = json.loads((E2E / "helpers" / "journal-run-contract.json").read_text())
ENV_TEST = Path(__file__).parents[2] / "chat-ui" / ".env.test"


class TestTheFixtureTheSpecUses:
    def test_stats_are_what_the_backend_computes(self):
        assert CONTRACT["stats"] == build_run_stats(
            CONTRACT["journals"], CONTRACT["accounts"]
        )

    def test_stats_after_posting_the_draft(self):
        journals = copy.deepcopy(CONTRACT["journals"])
        posted = CONTRACT["postedDraft"]
        draft = next(j for j in journals if j["id"] == posted["journalId"])
        draft["status"] = "posted"
        draft["line_items"][0]["account_id"] = posted["accountId"]
        assert CONTRACT["statsAfterPostingDraft"] == build_run_stats(
            journals, CONTRACT["accounts"]
        )

    def test_empty_run_stats(self):
        assert CONTRACT["statsOfEmptyRun"] == build_run_stats([], CONTRACT["accounts"])

    @pytest.mark.parametrize("key", ["narrative", "secondNarrative"])
    def test_narratives_have_the_models_shape(self, key):
        JournalRunNarrative(**CONTRACT[key])

    def test_status_message_has_the_published_fields(self):
        assert set(CONTRACT["status"]) == set(JournalPipelineStatusData.__annotations__)


def test_a_figures_only_read_never_asks_the_model(monkeypatch):
    class Service(JournalService):
        async def get_chart_of_accounts(self, entity_id=None):
            return CONTRACT["accounts"]

    async def fetched(service, entity_id, since):
        return copy.deepcopy(CONTRACT["journals"])

    async def must_not_run(stats):
        raise AssertionError("the model was called")

    monkeypatch.setattr(summary, "_fetch_run_journals", fetched)
    monkeypatch.setattr(summary, "_write_narrative", must_not_run)
    result = asyncio.run(
        summarize_journal_run(
            uuid.uuid4(),
            datetime.now(timezone.utc),
            Service(),
            include_narrative=False,
        )
    )
    assert result["narrative"] is None
    assert result["stats"] == CONTRACT["stats"]


class MemoisingStep:
    """Inngest's memoisation: a step's first result is what every replay gets."""

    def __init__(self, memo: Dict[str, Any]):
        self.memo = memo

    async def run(self, step_id, fn, *args):
        if step_id not in self.memo:
            result = fn(*args)
            self.memo[step_id] = await result if inspect.isawaitable(result) else result
        return self.memo[step_id]

    async def send_event(self, *args, **kwargs):
        return []


def test_every_status_of_a_run_carries_one_started_at_across_replays(monkeypatch):
    published: List[Dict[str, Any]] = []
    ticks = iter(range(100_000))

    async def publish(client, channel, topic, data):
        if topic == "status":
            published.append(dict(data))

    async def step_result(entity_id):
        return {"created": 1, "skipped": 0, "errors": []}

    monkeypatch.setattr(job.realtime, "publish", publish)
    # A clock that never repeats: anything not memoised would differ between replays.
    monkeypatch.setattr(job, "_now_iso", lambda: f"tick-{next(ticks)}")
    for _, _, method, _ in job.PIPELINE_STEPS:
        monkeypatch.setattr(job.journal_service, method, step_result)

    memo: Dict[str, Any] = {}
    ctx = SimpleNamespace(
        event=SimpleNamespace(data={"entity_id": str(uuid.uuid4()), "scope": "all"}),
        step=MemoisingStep(memo),
        logger=SimpleNamespace(info=lambda *a: None, error=lambda *a: None),
    )

    async def replay_twice():
        # `_handler` because a created Function is not callable (see CLAUDE.md).
        await job.generate_all_journals_job._handler(ctx)
        await job.generate_all_journals_job._handler(ctx)

    asyncio.run(replay_twice())

    assert len(published) == 2 * (1 + len(job.PIPELINE_STEPS) + 1)
    assert {p["started_at"] for p in published} == {memo["started-at"]}
    for message in published:
        assert set(message) == set(JournalPipelineStatusData.__annotations__)


# ── against the local database (skipped when it is not running) ──────────────────────


@pytest.fixture(scope="module")
def seed(_seed):  # noqa: F811
    return _seed


@pytest.fixture(scope="module")
def real_service() -> JournalService:
    if not ENV_TEST.exists():
        pytest.skip("no .env.test (pnpm db:fresh)")
    env = dict(
        line.split("=", 1)
        for line in ENV_TEST.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    if not env["SUPABASE_URL"].startswith(("http://127.0.0.1", "http://localhost")):
        pytest.skip("only ever against the local stack")
    service = JournalService()
    service._client = create_client(
        env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]
    )
    return service


# The seed's journals all share one created_at and the rival has none, so these rows
# are the test's own, in a window nothing else can be in.
WINDOW = datetime(2099, 1, 1, 10, 0, tzinfo=timezone.utc)


@pytest.fixture
def run_journals(seed):
    mine, rival = seed.a["entity_id"], seed.b["entity_id"]
    rows = {
        "before the run": (mine, WINDOW - timedelta(seconds=1), 11),
        "at the start": (mine, WINDOW, 22),
        "during the run": (mine, WINDOW + timedelta(minutes=5), 33),
        "another business": (rival, WINDOW + timedelta(minutes=1), 44),
    }
    conn = psycopg2.connect(LOCAL_DB, connect_timeout=2)
    ids: Dict[str, str] = {}
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "select id::text from chart_of_accounts where not is_header "
                "order by account_number limit 2"
            )
            debit, credit = [row[0] for row in cur.fetchall()]
            for label, (entity, created, amount) in rows.items():
                cur.execute(
                    "insert into journals (entity_id, journal_date, journal_type, "
                    "description, status, created_at) values "
                    "(%s, %s, 'adjustment', %s, 'posted', %s) returning id::text",
                    (entity, created, label, created),
                )
                ids[label] = cur.fetchone()[0]
                for account, dr, cr in ((debit, amount, 0), (credit, 0, amount)):
                    cur.execute(
                        "insert into journal_line_items "
                        "(journal_id, account_id, debit, credit, currency) "
                        "values (%s, %s, %s, %s, 'GBP')",
                        (ids[label], account, dr, cr),
                    )
        yield ids
    finally:
        with conn, conn.cursor() as cur:
            cur.execute(
                "delete from journal_line_items where journal_id = any(%s::uuid[])",
                (list(ids.values()),),
            )
            cur.execute(
                "delete from journals where id = any(%s::uuid[])",
                (list(ids.values()),),
            )
        conn.close()


def test_the_real_query_finds_this_run_and_nothing_else(
    seed, real_service, run_journals
):
    result = asyncio.run(
        summarize_journal_run(
            uuid.UUID(seed.a["entity_id"]),
            WINDOW,
            real_service,
            include_narrative=False,
        )
    )
    stats = result["stats"]
    assert {j["id"] for j in stats["largest_journals"]} == {
        run_journals["at the start"],
        run_journals["during the run"],
    }
    assert stats["journals_total"] == 2
    assert stats["total_amount"] == 55
    assert result["narrative"] is None


def test_another_businesss_journals_are_its_own(seed, real_service, run_journals):
    stats = asyncio.run(
        summarize_journal_run(
            uuid.UUID(seed.b["entity_id"]),
            WINDOW,
            real_service,
            include_narrative=False,
        )
    )["stats"]
    assert [j["id"] for j in stats["largest_journals"]] == [
        run_journals["another business"]
    ]
    assert stats["total_amount"] == 44
