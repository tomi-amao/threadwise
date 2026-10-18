"""The generative UI catalogue: every component the agent can show, and its props.

A component reaches the browser as a LangGraph UI message (`push_ui_message(name,
props)`), rendered from a local registry keyed by `name`. The props are defined once
here and mirrored as Zod schemas in the frontend
(`apps/chat-ui/app/components/assistant/catalogue.ts`). Both sides validate; an unknown
or invalid component renders nothing.

The two are kept in step by a contract file generated from these models (`python -m
ai_agent.ui.contract`): `tests/test_ui_contract.py` fails if it is out of date, and a
Playwright spec checks the Zod schemas against it. Bump `CATALOGUE_VERSION` for a change
an older browser could not render.

Every component that shows data carries a `Source`: which tool, which period, and a link
to the page where the figures live. That is the audit trail for trust.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CATALOGUE_VERSION = 1

Format = Literal["money", "number", "percent", "date", "text"]


class Props(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _internal_link(value: str | None) -> str | None:
    # Links come from tool results, but are still only ever paths inside the app.
    if value is not None and (not value.startswith("/") or value.startswith("//")):
        raise ValueError(
            "links must be paths inside the app, starting with a single '/'"
        )
    return value


class Period(Props):
    start: str = Field(description="First day, YYYY-MM-DD, inclusive.")
    end: str = Field(description="Last day, YYYY-MM-DD, inclusive.")


class Source(Props):
    """Where a component's figures came from."""

    tool: str = Field(description="The tool whose result this shows.")
    label: str = Field(description="What was read, e.g. 'Posted journals'.")
    period: Period | None = None
    as_of: str | None = Field(default=None, description="For a point-in-time figure.")
    link: str | None = Field(default=None, description="The page the figures live on.")

    @field_validator("link")
    @classmethod
    def _check_link(cls, value: str | None) -> str | None:
        return _internal_link(value)


class MetricDetail(Props):
    label: str
    value: float
    format: Format = "number"


class Metric(Props):
    """One headline figure, with a few supporting ones."""

    label: str
    value: float
    format: Format = "money"
    currency: str | None = None
    details: list[MetricDetail] = Field(default_factory=list, max_length=4)
    source: Source


class BarPoint(Props):
    label: str
    value: float


class BarChart(Props):
    title: str
    format: Format = "money"
    currency: str | None = None
    points: list[BarPoint] = Field(min_length=1, max_length=60)
    source: Source


class Column(Props):
    key: str
    label: str
    format: Format = "text"


Cell = str | float | int | None


class Table(Props):
    title: str
    columns: list[Column] = Field(min_length=1, max_length=8)
    rows: list[dict[str, Cell]] = Field(max_length=50)
    row_links: list[str | None] | None = Field(
        default=None, description="One per row: the page that opens that row."
    )
    total_rows: int | None = Field(
        default=None, description="How many rows matched, when only some are shown."
    )
    currency: str | None = None
    source: Source

    @model_validator(mode="after")
    def _rows_match(self) -> "Table":
        keys = {c.key for c in self.columns}
        for row in self.rows:
            if set(row) - keys:
                raise ValueError(
                    f"row has keys not in columns: {sorted(set(row) - keys)}"
                )
        if self.row_links is not None:
            if len(self.row_links) != len(self.rows):
                raise ValueError("row_links must have one entry per row")
            for link in self.row_links:
                _internal_link(link)
        return self


class SummaryRow(Props):
    label: str
    value: float
    kind: Literal["line", "total", "grand"] = "line"
    deduct: bool = Field(
        default=False, description="Shown in brackets, as a deduction."
    )
    indent: bool = Field(default=False, description="A part of the row above it.")


class SummaryList(Props):
    """Label-left, amount-right rows: a statement in miniature."""

    title: str
    currency: str | None = None
    format: Format = "money"
    rows: list[SummaryRow] = Field(min_length=1, max_length=20)
    source: Source


class FollowUp(Props):
    label: str = Field(min_length=1, max_length=60, description="What the chip says.")
    prompt: str = Field(min_length=1, max_length=300, description="What it sends.")


class FollowUps(Props):
    """Questions to ask next, shown as chips under the latest answer only."""

    items: list[FollowUp] = Field(min_length=2, max_length=4)


class ClarifyOption(Props):
    label: str = Field(min_length=1, max_length=60)


class Clarify(Props):
    """A question the agent pauses on (an interrupt); the user answers with a chip."""

    kind: Literal["clarify"] = "clarify"
    question: str = Field(min_length=1, max_length=200)
    options: list[ClarifyOption] = Field(min_length=2, max_length=4)


# name -> props model, for every component the browser can render.
COMPONENTS: dict[str, type[Props]] = {
    "metric": Metric,
    "bar-chart": BarChart,
    "table": Table,
    "summary-list": SummaryList,
    "follow-ups": FollowUps,
}

# kind -> payload model, for every interrupt the browser can answer.
INTERRUPTS: dict[str, type[Props]] = {"clarify": Clarify}
