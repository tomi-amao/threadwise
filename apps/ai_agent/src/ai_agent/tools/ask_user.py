"""A clarifying question the agent pauses on, answered with a click.

`ask_user` raises a LangGraph interrupt carrying a `Clarify` payload
(`ui/catalogue.py`). The browser shows the options as chips; the answer resumes the run
with `Command(resume={"answer": "..."})`, and the tool returns it to the model. The user
can also type an answer instead. The tool restarts from the top on resume, so nothing
happens before the interrupt.
"""

from typing import Any

from langchain.tools import ToolRuntime, tool
from langgraph.types import interrupt

from ..ui.catalogue import Clarify, ClarifyOption
from .identity import agent_user


@tool
def ask_user(question: str, options: list[str], runtime: ToolRuntime) -> str:
    """Ask the user one short question when the answer depends on a choice only they
    can make, offering 2 to 4 short options (for example "This month", "Last month").

    Only when guessing would give a different figure. When a sensible default exists
    (the current financial year), use it and say so instead of asking.
    """
    agent_user(runtime)
    payload = Clarify(
        question=question.strip(),
        options=[ClarifyOption(label=o.strip()) for o in options if o.strip()][:4],
    )
    answer: Any = interrupt(payload.model_dump(mode="json"))
    text = answer.get("answer") if isinstance(answer, dict) else answer
    return f"The user answered: {str(text or '').strip() or '(no answer)'}"
