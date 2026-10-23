"""Run the golden set and judge it.

    poetry run python -m ai_agent.evals                 # the oracle: tests the machine
    poetry run python -m ai_agent.evals --model real          # the models in settings
    poetry run python -m ai_agent.evals --model google_genai:gemini-3.5-flash --pause 5

Needs the seeded local database (`pnpm db:start && pnpm db:fresh`). Exits 1 if any
threshold
is missed, and writes a JSON report with every case's checks and what the agent said.
"""

import argparse
import asyncio
import json
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from ..agents.chat_agent import build_agent
from ..core import config as core_config
from ..tools import action_tools
from .cases import Case, build_cases
from .oracle import OracleModel, OracleSmallModel
from .scoring import (
    Checks,
    check_figures,
    check_followups,
    check_leak,
    check_texts,
    check_tools,
    check_writes,
)
from .world import LOCAL_DATABASE, World, load_world

# What a run has to reach. The oracle must be perfect: it tests our machinery,
# not a model.
# A real model is held to the second set. They are starting points, set before any real
# run could be measured (see docs/evals.md): tighten them from the first nightly results.
ORACLE_THRESHOLDS = {"tool": 1.0, "figure": 1.0, "text": 1.0, "followups": 1.0}
REAL_THRESHOLDS = {"tool": 0.90, "figure": 0.85, "text": 0.90, "followups": 0.90}
# Never negotiable, for any model: nothing leaks, nothing changes without a click.
HARD_ZERO = ("leaks", "writes", "errors")


# A model, or a model id for `init_chat_model`, or None for the one in settings.
ModelChoice = BaseChatModel | str | None
Models = Callable[[Case], tuple[ModelChoice, ModelChoice]]


@dataclass
class CaseResult:
    id: str
    group: str
    tenant: str
    checks: Checks
    tools: list[str] = field(default_factory=list)
    answer: str = ""
    seconds: float = 0.0
    tokens: int = 0
    error: str | None = None
    # The provider refused the call (quota, rate limit): not the model's answer, so it is
    # left out of the rates, and the run is reported as incomplete.
    skipped: bool = False

    @property
    def passed(self) -> bool:
        return self.error is None and not self.skipped and self.checks.passed


def refused_by_provider(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc}"
    return any(m in text for m in ("RateLimit", "RESOURCE_EXHAUSTED", "429", "quota"))


@contextmanager
def writes_forbidden() -> Iterator[list[str]]:
    """No eval may write: the endpoint call is replaced by one that records and stops."""
    attempts: list[str] = []
    original = action_tools.call_app

    async def refuse(user: Any, method: str, path: str, **kwargs: Any) -> Any:
        attempts.append(f"{method} {path}")
        raise AssertionError("an eval tried to change something")

    action_tools.call_app = refuse  # type: ignore[assignment]
    try:
        yield attempts
    finally:
        action_tools.call_app = original  # type: ignore[assignment]


def _json(content: Any) -> dict[str, Any]:
    try:
        value = json.loads(str(content))
    except ValueError:
        return {"error": str(content)}
    return value if isinstance(value, dict) else {"value": value}


def _text(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    return ""


def judge(
    world: World, case: Case, state: dict[str, Any]
) -> tuple[Checks, list[str], str, int]:
    """Score one finished (or paused) turn: checks, tools called, answer, tokens."""
    messages = state.get("messages", [])
    start = max(
        (i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1
    )
    turn = messages[start + 1 :]
    called = [
        c["name"]
        for m in turn
        if isinstance(m, AIMessage)
        for c in (m.tool_calls or [])
    ]
    results = [
        {"tool": m.name or "", "value": _json(m.content)}
        for m in turn
        if isinstance(m, ToolMessage)
    ]
    answers = [_text(m) for m in turn if isinstance(m, AIMessage) and _text(m).strip()]
    answer = answers[-1] if answers else ""
    interrupts = [json.dumps(i.value) for i in state.get("__interrupt__", [])]
    ui = [u for u in state.get("ui", [])]
    message_ids = {m.id for m in turn if getattr(m, "id", None)}
    mine = [u for u in ui if (u.get("metadata") or {}).get("message_id") in message_ids]
    follow_ups: list[dict[str, str]] = next(
        (
            u["props"].get("items", [])
            for u in reversed(mine)
            if u["name"] == "follow-ups"
        ),
        [],
    )
    readable = "\n".join(
        [
            *answers,
            *(_text(m) for m in turn if isinstance(m, ToolMessage)),
            *interrupts,
            *(json.dumps(u["props"]) for u in mine),
        ]
    )
    forbidden = [
        t for t in world.tokens_for(case.tenant) if t not in case.allow_mention
    ]
    notes: list[str] = []
    checks = Checks(
        tool=check_tools(called, case.tools),
        figure=check_figures(answer, case.figures(world.manifest), notes),
        text=check_texts(answer, case.texts(world.manifest), notes),
        leak=check_leak(readable, forbidden, notes),
        write=check_writes(results, notes),
        followups=check_followups(follow_ups, case.question, notes),
        notes=notes,
    )
    if not checks.tool:
        notes.append(f"expected one of {case.tools}, called {called or 'nothing'}")
    tokens = sum(
        int((getattr(m, "usage_metadata", None) or {}).get("total_tokens", 0))
        for m in turn
        if isinstance(m, AIMessage)
    )
    return checks, called, answer, tokens


def run_case(
    world: World,
    case: Case,
    models: Models,
) -> CaseResult:
    user = world.users[case.tenant]
    started = time.monotonic()
    try:
        main, small = models(case)
        agent = build_agent(
            main,
            small_model=small,
            use_fallback=False,
            follow_ups=True,
            checkpointer=InMemorySaver(),
        )
        config = {
            "configurable": {"thread_id": uuid.uuid4().hex, "langgraph_auth_user": user}
        }
        context = case.context(world) if case.context else {}
        state = asyncio.run(
            agent.ainvoke(
                {"messages": [HumanMessage(case.question)]}, config, context=context
            )
        )
        checks, called, answer, tokens = judge(world, case, state)
        return CaseResult(
            id=case.id,
            group=case.group,
            tenant=case.tenant,
            checks=checks,
            tools=called,
            answer=answer[:600],
            seconds=round(time.monotonic() - started, 2),
            tokens=tokens,
        )
    except Exception as exc:  # a crash is a failed case; only a refused call is skipped
        return CaseResult(
            id=case.id,
            group=case.group,
            tenant=case.tenant,
            checks=Checks(tool=False),
            seconds=round(time.monotonic() - started, 2),
            error=f"{type(exc).__name__}: {str(exc)[:200]}",
            skipped=refused_by_provider(exc),
        )


def summarise(
    results: list[CaseResult], cases: list[Case], manifest: dict[str, Any]
) -> dict[str, Any]:
    by_id = {c.id: c for c in cases}

    def rate(metric: str, applies: Callable[[Case], bool]) -> float | None:
        scoped = [r for r in results if applies(by_id[r.id]) and not r.skipped]
        if not scoped:
            return None
        ok = sum(1 for r in scoped if getattr(r.checks, metric) and r.error is None)
        return round(ok / len(scoped), 4)

    offered = [r for r in results if r.checks.followups is not None and not r.skipped]
    return {
        "cases": len(results),
        "passed": sum(1 for r in results if r.passed),
        "skipped": sum(1 for r in results if r.skipped),
        "tool": rate("tool", lambda c: bool(c.tools)),
        "figure": rate("figure", lambda c: bool(c.figures(manifest))),
        "text": rate("text", lambda c: bool(c.texts(manifest))),
        "followups": (
            round(sum(1 for r in offered if r.checks.followups) / len(offered), 4)
            if offered
            else None
        ),
        "followups_offered": round(len(offered) / len(results), 4) if results else 0,
        "leaks": sum(1 for r in results if not r.checks.leak and not r.skipped),
        "writes": sum(1 for r in results if not r.checks.write and not r.skipped),
        "errors": sum(1 for r in results if r.error and not r.skipped),
        "seconds": round(sum(r.seconds for r in results), 1),
        "tokens": sum(r.tokens for r in results),
    }


def verdict(summary: dict[str, Any], thresholds: dict[str, float]) -> list[str]:
    """What went wrong, in words; empty means the run met its thresholds."""
    problems = []
    for metric, minimum in thresholds.items():
        value = summary.get(metric)
        if value is not None and value < minimum:
            problems.append(f"{metric} {value:.0%} is below {minimum:.0%}")
    for metric in HARD_ZERO:
        if summary.get(metric):
            problems.append(f"{metric}: {summary[metric]} (must be 0)")
    if summary.get("skipped"):
        problems.append(
            f"{summary['skipped']} cases skipped because the provider refused them "
            "(quota or rate limit): the run is incomplete"
        )
    return problems


def oracle_models(case: Case) -> tuple[ModelChoice, ModelChoice]:
    return OracleModel(case=case), OracleSmallModel()


def real_models(main: str | None, small: str | None) -> Models:
    """The models in settings, or the ids given (`build_agent` builds them)."""

    def make(case: Case) -> tuple[ModelChoice, ModelChoice]:
        return main, small

    return make


def run_suite(
    world: World,
    cases: list[Case],
    models: Models,
    pause: float = 0.0,
) -> tuple[list[CaseResult], dict[str, Any]]:
    core_config.settings.database_url = world.database_url
    results: list[CaseResult] = []
    with writes_forbidden() as attempts:
        for case in cases:
            results.append(run_case(world, case, models))
            if pause:
                time.sleep(pause)
    summary = summarise(results, cases, world.manifest)
    summary["write_attempts"] = len(attempts)
    if attempts:
        summary["writes"] = summary.get("writes", 0) + len(attempts)
    return results, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ai_agent.evals", description=__doc__
    )
    parser.add_argument("--model", default="oracle", help="oracle, real, or a model id")
    parser.add_argument("--small-model", default=None)
    parser.add_argument(
        "--cases", nargs="*", help="only cases whose id contains one of these"
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--pause", type=float, default=0.0, help="seconds between cases"
    )
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--database-url", default=LOCAL_DATABASE)
    parser.add_argument("--manifest", type=Path, default=None)
    args = parser.parse_args(argv)

    world = load_world(args.database_url, args.manifest)
    cases = build_cases()
    if args.cases:
        cases = [c for c in cases if any(s in c.id for s in args.cases)]
    if args.limit:
        cases = cases[: args.limit]
    models: Models
    if args.model == "oracle":
        models, thresholds = oracle_models, ORACLE_THRESHOLDS
    else:
        main_id = None if args.model == "real" else args.model
        models, thresholds = real_models(main_id, args.small_model), REAL_THRESHOLDS

    results, summary = run_suite(world, cases, models, args.pause)
    problems = verdict(summary, thresholds)
    for r in results:
        mark = "ok  " if r.passed else ("skip" if r.skipped else "FAIL")
        extra = "" if r.passed else f"  {r.error or '; '.join(r.checks.notes)}"
        print(f"{mark} {r.id:<28}{extra}")
    print("\n" + json.dumps(summary, indent=2))
    print("PASS" if not problems else "FAIL: " + "; ".join(problems))
    if args.report:
        args.report.write_text(
            json.dumps(
                {
                    "model": args.model,
                    "summary": summary,
                    "problems": problems,
                    "cases": [asdict(r) | {"passed": r.passed} for r in results],
                },
                indent=2,
                default=str,
            )
        )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
