from __future__ import annotations
from dataclasses import dataclass
from typing import TypedDict

class Context(TypedDict):
    """Context parameters for the agent."""
    model_name: str

@dataclass
class State:
    """Input state for the agent."""
    question: str = "example"
    answer: str = ""
    analysis_results: str = ""