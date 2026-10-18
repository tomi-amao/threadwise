"""The chat agent: one `create_agent` tool-calling loop over the business's own data.

The model decides which tools to call; there is no classifier or router in front of it.
Cross-cutting behaviour is middleware rather than graph nodes:

- `BusinessContextMiddleware` refuses a run with no signed-in user, answers file
  attachments with a pointer to the Invoices page (extraction is not part of chat), and
  adds today's date and the business profile to the system prompt each turn.
- Summarisation of long threads, model and tool call caps, retries, a fallback model,
  and tool errors returned to the model as text.

Who the agent works for comes only from the auth layer
(`config["configurable"]["langgraph_auth_user"]`, see `auth.py`); every tool reads it
through `ToolRuntime` and runs its SQL as that user with row-level security on.

`build_agent()` does no I/O and builds no models unless asked to, so this module is
safe to import without API keys. The server's graph is `agents/chat_graph.py:agent`.
"""

import datetime as dt
import logging
from typing import Annotated, Any, NotRequired, cast

import psycopg2  # type: ignore[import-untyped]
from langchain.agents import AgentState, create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ModelCallLimitMiddleware,
    ModelFallbackMiddleware,
    ModelRetryMiddleware,
    SummarizationMiddleware,
    ToolCallLimitMiddleware,
    ToolErrorMiddleware,
    ToolRetryMiddleware,
    hook_config,
)
from langchain.agents.middleware.types import ModelRequest
from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.config import get_config
from langgraph.graph.ui import AnyUIMessage, ui_message_reducer
from langgraph.types import Checkpointer

from ..core.config import settings
from ..tools.ask_user import ask_user
from ..tools.data_tools import (
    DATA_TOOLS,
    financial_year,
    load_coverage,
    load_profile,
    today,
)
from ..tools.document_tools import search_documents
from ..tools.identity import agent_user_from_config
from ..tools.sql_tools import SQL_TOOLS
from .chat_prompt import SYSTEM_PROMPT
from .ui_middleware import FollowUpsMiddleware, GenerativeUIMiddleware

logger = logging.getLogger(__name__)

TOOLS = [*DATA_TOOLS, search_documents, *SQL_TOOLS, ask_user]

ATTACHMENT_REPLY = (
    "I can't read attached files in chat yet. To add an invoice or receipt, upload it "
    "on the [Invoices page](/invoices), and then ask me about it here."
)

# Limits per user turn (a "run"). Generous for a few lookups, tight enough for cost.
MODEL_CALLS_PER_TURN = 12
TOOL_CALLS_PER_TURN = 20
SUMMARISE_AFTER_TOKENS = 60_000
KEEP_MESSAGES = 20


class ChatState(AgentState):
    """The agent's state, plus what the middleware adds.

    `business`: the profile and data coverage, loaded at the start of each turn.
    `guard_answered`: this turn was answered before the model (no user, an attachment).
    `ui`: generative UI messages (`push_ui_message`), merged by `ui_message_reducer`.
    """

    business: NotRequired[dict[str, Any] | None]
    guard_answered: NotRequired[bool]
    ui: NotRequired[Annotated[list[AnyUIMessage], ui_message_reducer]]


def _has_attachment(message: Any) -> bool:
    content = getattr(message, "content", None)
    if not isinstance(content, list):
        return False
    return any(
        isinstance(block, dict) and block.get("type") not in (None, "text")
        for block in content
    )


def business_context(business: dict[str, Any] | None, on: dt.date) -> str:
    """The per-turn block appended to the system prompt."""
    lines = [f"Today is {on.isoformat()} ({on.strftime('%A')})."]
    if business:
        fy = business.get("financial_year") or {}
        lines += [
            f"The business is {business.get('name')}"
            f" ({business.get('country') or 'country not set'}).",
            f"Its currency is {business.get('currency')}; the ledger reports in GBP.",
            f"The current financial year runs {fy.get('start')} to {fy.get('end')}.",
            "VAT registered: "
            + ("yes" if business.get("vat_registered") else "no or not set")
            + ".",
        ]
        covered = [
            f"{c['data']} {c['first']} to {c['last']} ({c['rows']})"
            for c in business.get("coverage") or []
            if c.get("rows")
        ]
        empty = [c["data"] for c in business.get("coverage") or [] if not c.get("rows")]
        if covered:
            lines.append("Data on record: " + "; ".join(covered) + ".")
        if empty:
            lines.append("No data yet for: " + ", ".join(empty) + ".")
    return "\n".join(lines)


class BusinessContextMiddleware(AgentMiddleware[ChatState]):
    """Who and when: refuse anonymous runs, add the business and date to the prompt."""

    state_schema = ChatState

    @hook_config(can_jump_to=["end"])
    async def abefore_agent(self, state: ChatState, runtime: Any) -> dict[str, Any]:
        try:
            user = agent_user_from_config(get_config())
        except PermissionError as exc:
            return {
                "messages": [AIMessage(content=str(exc))],
                "guard_answered": True,
                "jump_to": "end",
            }

        last_human = next(
            (m for m in reversed(state["messages"]) if isinstance(m, HumanMessage)),
            None,
        )
        if last_human is not None and _has_attachment(last_human):
            return {
                "messages": [AIMessage(content=ATTACHMENT_REPLY)],
                "guard_answered": True,
                "jump_to": "end",
            }

        try:
            profile = await load_profile(user)
            coverage = await load_coverage(user)
        except (psycopg2.Error, PermissionError, RuntimeError) as exc:
            # The tools will say what is wrong; the prompt just goes without the profile.
            logger.warning("Business profile not loaded: %s", type(exc).__name__)
            return {"business": None, "guard_answered": False}
        start, end = financial_year(
            today(), profile.get("year_end_month"), profile.get("year_end_day")
        )
        return {
            "business": {
                "name": profile.get("name"),
                "currency": profile.get("currency") or "GBP",
                "country": profile.get("country"),
                "vat_registered": profile.get("vat_registered"),
                "financial_year": {"start": start.isoformat(), "end": end.isoformat()},
                "coverage": coverage,
            },
            "guard_answered": False,
        }

    async def awrap_model_call(self, request: ModelRequest, handler: Any) -> Any:
        base = request.system_message.content if request.system_message else ""
        business = cast(dict[str, Any] | None, request.state.get("business"))
        extra = business_context(business, today())
        system = SystemMessage(content=f"{base}\n\n{extra}")
        return await handler(request.override(system_message=system))


def tool_error_message(exc: Exception, request: Any) -> str:
    """What the model is told when a tool fails (no internal detail)."""
    name = request.tool_call.get("name", "the tool")
    if isinstance(exc, PermissionError):
        return f"Error: {exc}"
    if isinstance(exc, ValueError):
        return f"Error in the arguments to {name}: {exc}"
    if isinstance(exc, psycopg2.Error):
        logger.warning("%s: database error %s", name, type(exc).__name__)
        return (
            f"Error: {name} could not read the data ({type(exc).__name__}). "
            "Try a narrower question, or say the data is not available right now."
        )
    logger.exception("%s failed", name, exc_info=exc)
    return f"Error: {name} failed unexpectedly. Tell the user it is not available now."


# The provider client's own retries are kept short. It retries a quota error (HTTP 429)
# for minutes by default (Gemini: 6 retries, backing off to 16s), which holds a turn up
# while the fallback model sits idle. Retrying does not clear a daily quota; the retry
# middleware and the fallback model (its own quota) take over within seconds instead.
CLIENT_MAX_RETRIES = 1
CLIENT_TIMEOUT_S = 90


def _model(model: str | BaseChatModel) -> BaseChatModel:
    if not isinstance(model, str):
        return model
    return init_chat_model(
        model, max_retries=CLIENT_MAX_RETRIES, timeout=CLIENT_TIMEOUT_S
    )


def build_agent(
    model: str | BaseChatModel | None = None,
    *,
    fallback_model: str | BaseChatModel | None = None,
    small_model: str | BaseChatModel | None = None,
    use_fallback: bool = True,
    follow_ups: bool = True,
    checkpointer: Checkpointer = None,
) -> Any:
    """The chat agent graph. Models default to the `agent_*` settings.

    `follow_ups=False` leaves out the end-of-turn follow-up step (one small-model call).

    No checkpointer by default: the LangGraph server supplies its own (with the TTL
    from langgraph.json). Tests pass an in-memory one.
    """
    main = _model(model or settings.agent_model)
    small = _model(small_model or settings.agent_small_model)
    fallback = fallback_model or settings.agent_fallback_model

    middleware: list[AgentMiddleware[Any, Any]] = [
        BusinessContextMiddleware(),
        SummarizationMiddleware(
            small,
            trigger=("tokens", SUMMARISE_AFTER_TOKENS),
            keep=("messages", KEEP_MESSAGES),
        ),
        ModelCallLimitMiddleware(run_limit=MODEL_CALLS_PER_TURN, exit_behavior="end"),
        ToolCallLimitMiddleware(run_limit=TOOL_CALLS_PER_TURN),
    ]
    if follow_ups:
        middleware.append(FollowUpsMiddleware(small, TOOLS))
    if use_fallback and fallback:
        # Outside the retry: the main model is retried first, then the fallback is tried.
        middleware.append(ModelFallbackMiddleware(_model(fallback)))
    middleware += [
        ModelRetryMiddleware(max_retries=2, on_failure="error"),
        # Outside the error handler, so it only sees results that are not errors.
        GenerativeUIMiddleware(),
        # Errors outside, retries inside: a dropped connection is retried, anything
        # left becomes an error message to the model instead of failing the turn.
        ToolErrorMiddleware(tool_error_message),
        ToolRetryMiddleware(
            max_retries=2,
            retry_on=(psycopg2.OperationalError,),
            on_failure="error",
            initial_delay=0.5,
        ),
    ]
    return create_agent(
        main,
        TOOLS,
        system_prompt=SYSTEM_PROMPT,
        middleware=middleware,
        state_schema=ChatState,
        checkpointer=checkpointer,
        name="threadwise-chat",
    )
