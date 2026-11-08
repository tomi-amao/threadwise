"""What the Summary tab's end-to-end test cannot see from the browser.

The Playwright spec fakes the agent, so three things are checked here instead:

- The fixture it answers with is what the backend really produces, and the status
  message it sends has the fields the job really publishes.
- The job records its run, and every status message names that run.
- The real database links journals to runs and allows one active run per business
  (needs the local stack).
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
from fastapi import HTTPException
from supabase import create_client

from ai_agent.api.routes import accounting
from ai_agent.integrations.inngest import journal_generation_functions as job
from ai_agent.integrations.inngest.channels import JournalPipelineStatusData
from ai_agent.services import journal_run_summary as summary
from ai_agent.services.journal_run_summary import (
    JournalRunNarrative,
    JournalRunNotFound,
    build_run_stats,
    summarize_journal_run,
)
from ai_agent.services.journal_runs import (
    ABANDONED_REASON,
    MAX_STORED_ERRORS,
    JournalRunStore,
    compact_step,
)
from ai_agent.services.journal_service import (
    JournalService,
    _generation_run,
    recording_generation_run,
)

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


class Runs(JournalRunStore):
    """The run store, recording what the job asked of it."""

    def __init__(self, stored: Any = None):
        super().__init__()
        self.calls: List[Any] = []
        self.stored = stored

    async def get_run(self, entity_id, run_id):
        return {"id": str(run_id), "narrative": self.stored}

    async def mark_running(self, run_id):
        self.calls.append(("running", run_id))

    async def save_progress(self, run_id, steps, totals):
        self.calls.append(("progress", run_id, len(steps), dict(totals)))

    async def finish_run(self, run_id, status, steps, totals):
        self.calls.append(
            ("finish", run_id, status, copy.deepcopy(steps), dict(totals))
        )

    async def fail_run(self, run_id, reason):
        self.calls.append(("fail", run_id, reason))


def test_a_figures_only_read_never_asks_the_model(monkeypatch):
    class Service(JournalService):
        async def get_chart_of_accounts(self, entity_id=None):
            return CONTRACT["accounts"]

    async def fetched(service, entity_id, run_id):
        return copy.deepcopy(CONTRACT["journals"])

    async def must_not_run(stats):
        raise AssertionError("the model was called")

    monkeypatch.setattr(summary, "_fetch_run_journals", fetched)
    monkeypatch.setattr(summary, "_write_narrative", must_not_run)
    result = asyncio.run(
        summarize_journal_run(
            uuid.uuid4(),
            uuid.uuid4(),
            Service(),
            include_narrative=False,
            runs=Runs(),
        )
    )
    assert result["narrative"] is None
    assert result["stats"] == CONTRACT["stats"]


class TestCompactStep:
    def test_a_long_error_list_is_capped_but_counted(self):
        step = {"errors": [{"error": str(i)} for i in range(MAX_STORED_ERRORS + 5)]}
        compact = compact_step(step)
        assert len(compact["errors"]) == MAX_STORED_ERRORS
        assert compact["errors_total"] == MAX_STORED_ERRORS + 5

    def test_per_type_detail_keeps_counts_only(self):
        step = {
            "errors": [],
            "by_type": {
                "refund": {
                    "total": 3,
                    "created": 1,
                    "skipped": 1,
                    "errors": [{"transaction_id": "t", "error": "no"}],
                }
            },
        }
        assert compact_step(step)["by_type"] == {
            "refund": {"total": 3, "created": 1, "skipped": 1, "errors": 1}
        }


class FakeRpc:
    def __init__(self):
        self.params: List[Dict[str, Any]] = []

    def rpc(self, name, params):
        self.params.append(params)
        return SimpleNamespace(execute=lambda: SimpleNamespace(data="journal-id"))


def test_journals_written_inside_a_run_are_linked_to_it_and_others_are_not():
    class Service(JournalService):
        async def _fetch_journal(self, journal_id):
            return {"id": journal_id}

    service = Service()
    fake = FakeRpc()
    service._client = fake
    write = dict(
        entity_id=uuid.uuid4(),
        journal_date="2026-11-08",
        journal_type="adjustment",
        description="d",
        source_type=None,
        source_id=None,
        status="posted",
        line_items=[{"account_id": "a", "debit": 1}],
    )

    async def both():
        with recording_generation_run("run-1"):
            await service._create_journal(**write)
        await service._create_journal(**write)

    asyncio.run(both())
    assert [p["p_generation_run_id"] for p in fake.params] == ["run-1", None]


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


RUN_ID = str(uuid.uuid4())
ENTITY_ID = str(uuid.uuid4())


def context(data: Dict[str, Any], memo: Dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(
        event=SimpleNamespace(data=data),
        step=MemoisingStep(memo),
        logger=SimpleNamespace(info=lambda *a: None, error=lambda *a: None),
    )


@pytest.fixture
def pipeline(monkeypatch):
    """The job with its journals and its record faked; returns what it published."""
    published: List[Dict[str, Any]] = []
    runs = Runs()

    async def publish(client, channel, topic, data):
        if topic == "status":
            published.append(dict(data))

    async def step_result(entity_id):
        return {"created": 1, "skipped": 0, "errors": []}

    monkeypatch.setattr(job.realtime, "publish", publish)
    monkeypatch.setattr(job, "journal_runs", runs)
    for _, _, method, _ in job.PIPELINE_STEPS:
        monkeypatch.setattr(job.journal_service, method, step_result)
    return SimpleNamespace(published=published, runs=runs)


def run_job(memo: Dict[str, Any], times: int = 1) -> None:
    ctx = context({"entity_id": ENTITY_ID, "scope": "all", "run_id": RUN_ID}, memo)

    async def go():
        # `_handler` because a created Function is not callable (see CLAUDE.md).
        for _ in range(times):
            await job.generate_all_journals_job._handler(ctx)

    asyncio.run(go())


class TestTheJobRecordsItsRun:
    def test_every_status_names_the_run_across_replays(self, pipeline):
        run_job({}, times=2)
        assert len(pipeline.published) == 2 * (1 + len(job.PIPELINE_STEPS) + 1)
        assert {p["run_id"] for p in pipeline.published} == {RUN_ID}
        for message in pipeline.published:
            assert set(message) == set(JournalPipelineStatusData.__annotations__)

    def test_replays_write_the_record_once(self, pipeline):
        run_job({}, times=2)
        kinds = [c[0] for c in pipeline.runs.calls]
        assert kinds == ["running", *["progress"] * len(job.PIPELINE_STEPS), "finish"]

    def test_the_record_ends_with_what_happened(self, pipeline):
        run_job({})
        _, run_id, status, steps, totals = pipeline.runs.calls[-1]
        assert (run_id, status) == (RUN_ID, "completed")
        assert [s["step"] for s in steps] == [k for k, *_ in job.PIPELINE_STEPS]
        assert totals == {
            "total_created": len(job.PIPELINE_STEPS),
            "total_skipped": 0,
            "total_errors": 0,
        }

    def test_a_failed_step_is_recorded_and_the_rest_still_run(
        self, pipeline, monkeypatch
    ):
        async def broken(entity_id):
            raise RuntimeError("the bank line is unreadable")

        step_key, _, method, _ = job.PIPELINE_STEPS[1]
        monkeypatch.setattr(job.journal_service, method, broken)
        run_job({})
        _, _, status, steps, totals = pipeline.runs.calls[-1]
        assert status == "completed_with_errors"
        failed = next(s for s in steps if s["step"] == step_key)
        assert failed["status"] == "error"
        assert "unreadable" in failed["error"]
        assert totals["total_errors"] == 1
        assert len(steps) == len(job.PIPELINE_STEPS)

    def test_journals_are_written_under_the_run(self, pipeline, monkeypatch):
        seen = []

        async def looks(entity_id):
            seen.append(_generation_run.get())
            return {"created": 0, "skipped": 0, "errors": []}

        for _, _, method, _ in job.PIPELINE_STEPS:
            monkeypatch.setattr(job.journal_service, method, looks)
        run_job({})
        assert seen == [RUN_ID] * len(job.PIPELINE_STEPS)
        assert _generation_run.get() is None


class TestTheFailureHandler:
    def failed(self, memo, data):
        ctx = context({"event": {"data": data}}, memo)
        asyncio.run(job.generate_all_journals_job._opts.on_failure(ctx))

    def test_it_closes_the_run_and_tells_the_modal(self, pipeline):
        self.failed({}, {"entity_id": ENTITY_ID, "scope": "all", "run_id": RUN_ID})
        assert pipeline.runs.calls == [
            ("fail", RUN_ID, "The run stopped unexpectedly.")
        ]
        [message] = pipeline.published
        assert (message["status"], message["run_id"]) == ("error", RUN_ID)
        assert set(message) == set(JournalPipelineStatusData.__annotations__)

    def test_without_a_run_there_is_nothing_to_close(self, pipeline):
        self.failed({}, {"entity_id": ENTITY_ID})
        assert pipeline.runs.calls == [] and pipeline.published == []


class TestGenerateAllRoute:
    @pytest.fixture
    def route(self, monkeypatch):
        sent: List[Any] = []
        failed: List[Any] = []
        state = SimpleNamespace(
            sent=sent, failed=failed, created=True, send_fails=False
        )

        async def start_run(entity_id, scope):
            return {"id": RUN_ID, "scope": scope}, state.created

        async def fail_run(run_id, reason):
            failed.append(run_id)

        class Client:
            async def send(self, event):
                if state.send_fails:
                    raise RuntimeError("Inngest is down")
                sent.append(event)

        monkeypatch.setattr(accounting.journal_runs, "start_run", start_run)
        monkeypatch.setattr(accounting.journal_runs, "fail_run", fail_run)
        monkeypatch.setattr("ai_agent.integrations.inngest.get_client", Client)
        return state

    def call(self, scope=None):
        request = accounting.GenerateAllJournalsRequest(
            entity_id=ENTITY_ID, scope=scope
        )
        return asyncio.run(accounting.generate_all_journals(request))

    def test_it_records_the_run_before_queueing_the_job(self, route):
        result = self.call("payments")
        assert result["run_id"] == RUN_ID and result["status"] == "triggered"
        [event] = route.sent
        assert event.data == {
            "entity_id": ENTITY_ID,
            "scope": "payments",
            "run_id": RUN_ID,
        }

    def test_a_second_click_joins_the_run_and_queues_nothing(self, route):
        route.created = False
        result = self.call()
        assert result["status"] == "already_running" and result["run_id"] == RUN_ID
        assert route.sent == []

    def test_a_run_that_could_not_be_queued_is_closed(self, route):
        route.send_fails = True
        with pytest.raises(HTTPException) as refused:
            self.call()
        assert refused.value.status_code == 500
        assert route.failed == [RUN_ID]

    def test_an_unknown_scope_is_refused(self, route):
        with pytest.raises(HTTPException) as refused:
            self.call("everything")
        assert refused.value.status_code == 422
        assert route.sent == []


def test_the_summary_route_says_404_for_a_run_it_cannot_find(monkeypatch):
    async def missing(*args, **kwargs):
        raise JournalRunNotFound("x")

    monkeypatch.setattr(accounting, "summarize_journal_run", missing)
    request = accounting.JournalRunSummaryRequest(
        entity_id=ENTITY_ID, run_id=uuid.UUID(RUN_ID)
    )
    with pytest.raises(HTTPException) as refused:
        asyncio.run(accounting.journal_run_summary(request))
    assert refused.value.status_code == 404


# ── against the local database (skipped when it is not running) ──────────────────────


@pytest.fixture(scope="module")
def seed(_seed):  # noqa: F811
    return _seed


@pytest.fixture(scope="module")
def client():
    if not ENV_TEST.exists():
        pytest.skip("no .env.test (pnpm db:fresh)")
    env = dict(
        line.split("=", 1)
        for line in ENV_TEST.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    if not env["SUPABASE_URL"].startswith(("http://127.0.0.1", "http://localhost")):
        pytest.skip("only ever against the local stack")
    return create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])


@pytest.fixture
def real_service(client) -> JournalService:
    service = JournalService()
    service._client = client
    return service


@pytest.fixture
def store(client) -> JournalRunStore:
    runs = JournalRunStore()
    runs._client = client
    return runs


@pytest.fixture
def db(seed):
    """A connection that removes this test's runs and journals afterwards."""
    conn = psycopg2.connect(LOCAL_DB, connect_timeout=2)
    conn.autocommit = True
    before = conn.cursor()
    before.execute("select id from journal_generation_runs")
    seeded_runs = [row[0] for row in before.fetchall()]
    yield conn
    with conn.cursor() as cur:
        # One transaction: the ledger guards check each journal's lines at commit.
        cur.execute("begin")
        cur.execute(
            "delete from journal_line_items where journal_id in "
            "(select id from journals where source_type = 'run-test' "
            "or description like 'run-test %')"
        )
        cur.execute(
            "delete from journals where source_type = 'run-test' "
            "or description like 'run-test %'"
        )
        cur.execute(
            "delete from journal_generation_runs where not (id = any(%s::uuid[]))",
            (seeded_runs,),
        )
        cur.execute("commit")
    conn.close()


def accounts_for_lines(conn) -> List[str]:
    with conn.cursor() as cur:
        cur.execute(
            "select id::text from chart_of_accounts where not is_header "
            "order by account_number limit 2"
        )
        return [row[0] for row in cur.fetchall()]


def add_run(conn, entity: str, status: str = "completed") -> str:
    with conn.cursor() as cur:
        cur.execute(
            "insert into journal_generation_runs (entity_id, status) "
            "values (%s, %s) returning id::text",
            (entity, status),
        )
        return cur.fetchone()[0]


def add_journal(conn, entity: str, run: Any, label: str, amount: int) -> str:
    debit, credit = accounts_for_lines(conn)
    with conn.cursor() as cur:
        cur.execute("begin")
        cur.execute(
            "insert into journals (entity_id, journal_date, journal_type, description, "
            "status, generation_run_id) values (%s, '2099-01-01', 'adjustment', %s, "
            "'posted', %s) returning id::text",
            (entity, f"run-test {label}", run),
        )
        journal = cur.fetchone()[0]
        for account, dr, cr in ((debit, amount, 0), (credit, 0, amount)):
            cur.execute(
                "insert into journal_line_items "
                "(journal_id, account_id, debit, credit, currency) "
                "values (%s, %s, %s, %s, 'GBP')",
                (journal, account, dr, cr),
            )
        cur.execute("commit")
    return journal


def stats_of(entity: str, run: str, service, store) -> Dict[str, Any]:
    return asyncio.run(
        summarize_journal_run(
            uuid.UUID(entity),
            uuid.UUID(run),
            service,
            include_narrative=False,
            runs=store,
        )
    )["stats"]


class TestTheRealQuery:
    def test_it_finds_this_runs_journals_and_nothing_else(
        self, seed, real_service, store, db
    ):
        mine = seed.a["entity_id"]
        this_run, other_run = add_run(db, mine), add_run(db, mine)
        first = add_journal(db, mine, this_run, "first", 22)
        second = add_journal(db, mine, this_run, "second", 33)
        add_journal(db, mine, other_run, "another run", 44)
        add_journal(db, mine, None, "no run", 55)

        stats = stats_of(mine, this_run, real_service, store)
        assert {j["id"] for j in stats["largest_journals"]} == {first, second}
        assert stats["total_amount"] == 55

    def test_another_businesss_run_is_not_found(self, seed, real_service, store, db):
        theirs = add_run(db, seed.b["entity_id"])
        add_journal(db, seed.b["entity_id"], theirs, "theirs", 66)
        with pytest.raises(JournalRunNotFound):
            stats_of(seed.a["entity_id"], theirs, real_service, store)


class TestTheDatabaseFunction:
    def write(self, client, entity, source, accounts, **extra):
        debit, credit = accounts
        return (
            client.rpc(
                "upsert_journal_with_lines",
                {
                    "p_entity_id": entity,
                    "p_journal_date": "2099-01-01",
                    "p_journal_type": "adjustment",
                    "p_description": "run-test upsert",
                    "p_source_type": "run-test",
                    "p_source_id": source,
                    "p_status": "posted",
                    "p_metadata": {},
                    "p_line_items": [
                        {"account_id": debit, "debit": 5},
                        {"account_id": credit, "credit": 5},
                    ],
                    **extra,
                },
            )
            .execute()
            .data
        )

    def run_of(self, conn, journal) -> Any:
        with conn.cursor() as cur:
            cur.execute(
                "select generation_run_id::text from journals where id = %s", (journal,)
            )
            return cur.fetchone()[0]

    def test_a_journal_keeps_the_run_that_first_created_it(self, seed, client, db):
        entity = seed.a["entity_id"]
        first, later = add_run(db, entity), add_run(db, entity)
        source, accounts = str(uuid.uuid4()), accounts_for_lines(db)
        journal = self.write(
            client, entity, source, accounts, p_generation_run_id=first
        )
        assert self.run_of(db, journal) == first
        self.write(client, entity, source, accounts, p_generation_run_id=later)
        assert self.run_of(db, journal) == first

    def test_callers_that_pass_no_run_still_work(self, seed, client, db):
        journal = self.write(
            client, seed.a["entity_id"], str(uuid.uuid4()), accounts_for_lines(db)
        )
        assert self.run_of(db, journal) is None


class TestOneActiveRunPerBusiness:
    def test_a_second_start_joins_the_first(self, seed, store, db):
        entity = uuid.UUID(seed.b["entity_id"])
        first, created = asyncio.run(store.start_run(entity, "all"))
        again, created_again = asyncio.run(store.start_run(entity, "payments"))
        assert created and not created_again
        assert again["id"] == first["id"]

    def test_a_finished_run_frees_the_business(self, seed, store, db):
        entity = uuid.UUID(seed.b["entity_id"])
        first, _ = asyncio.run(store.start_run(entity, "all"))
        asyncio.run(store.finish_run(first["id"], "completed", [], {}))
        second, created = asyncio.run(store.start_run(entity, "all"))
        assert created and second["id"] != first["id"]

    def test_a_lost_run_does_not_block_the_next_for_ever(self, seed, store, db):
        entity = uuid.UUID(seed.b["entity_id"])
        lost, _ = asyncio.run(store.start_run(entity, "all"))
        with db.cursor() as cur:
            cur.execute(
                "update journal_generation_runs set created_at = %s where id = %s",
                (datetime.now(timezone.utc) - timedelta(hours=3), lost["id"]),
            )
        fresh, created = asyncio.run(store.start_run(entity, "all"))
        assert created and fresh["id"] != lost["id"]
        closed = asyncio.run(store.get_run(entity, uuid.UUID(lost["id"])))
        assert (closed["status"], closed["failure_reason"]) == (
            "failed",
            ABANDONED_REASON,
        )

    def test_failing_a_closed_run_leaves_it_as_it_was(self, seed, store, db):
        entity = uuid.UUID(seed.b["entity_id"])
        run, _ = asyncio.run(store.start_run(entity, "all"))
        asyncio.run(store.finish_run(run["id"], "completed", [], {}))
        asyncio.run(store.fail_run(run["id"], "too late"))
        after = asyncio.run(store.get_run(entity, uuid.UUID(run["id"])))
        assert (after["status"], after["failure_reason"]) == ("completed", None)
