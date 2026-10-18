"""The generative UI catalogue, its presenters, and the contract file for the frontend."""

import json

import pytest
from pydantic import ValidationError

from ai_agent.agents.ui_middleware import clean_follow_ups
from ai_agent.ui import contract
from ai_agent.ui.catalogue import COMPONENTS, Clarify, FollowUp, Source, Table
from ai_agent.ui.presenters import present


def test_the_contract_file_is_current():
    # Compared as data, so formatting (Prettier on commit) does not matter.
    committed = json.loads(contract.CONTRACT_FILE.read_text())
    assert committed == json.loads(contract.render()), (
        "The UI catalogue changed: run `poetry run python -m ai_agent.ui.contract` "
        "and update the Zod schemas in apps/chat-ui/app/components/assistant/catalogue.ts"
    )


def test_every_component_has_an_example_and_every_example_is_valid():
    examples = contract.examples()
    for name, model in COMPONENTS.items():
        assert examples[name], f"no example for {name}"
        for props in examples[name]:
            model.model_validate(props)


@pytest.mark.parametrize(
    "link", ["https://evil.example", "//evil.example/x", "reports"]
)
def test_links_can_only_point_inside_the_app(link):
    with pytest.raises(ValidationError):
        Source(tool="t", label="l", link=link)


def test_a_table_row_must_match_its_columns_and_links():
    base = {
        "title": "T",
        "columns": [{"key": "a", "label": "A"}],
        "source": {"tool": "t", "label": "l"},
    }
    Table.model_validate({**base, "rows": [{"a": 1}], "row_links": ["/orders"]})
    with pytest.raises(ValidationError):
        Table.model_validate({**base, "rows": [{"b": 1}]})
    with pytest.raises(ValidationError):
        Table.model_validate({**base, "rows": [{"a": 1}], "row_links": []})
    with pytest.raises(ValidationError):
        Table.model_validate({**base, "rows": [{"a": 1}], "row_links": ["https://x.y"]})


def test_unknown_props_are_refused():
    with pytest.raises(ValidationError):
        Source(tool="t", label="l", colour="red")  # type: ignore[call-arg]


def test_presenters_use_the_tool_figures_exactly():
    args, result = contract.SAMPLE_RESULTS["profit_and_loss"]
    ((name, props),) = present("profit_and_loss", args, result)
    assert name == "summary-list"
    values = {row.label: row.value for row in props.rows}  # type: ignore[attr-defined]
    assert values["Net profit"] == result["net_profit"]
    assert values["Revenue"] == result["revenue"]
    assert props.source.link == result["link"]  # type: ignore[attr-defined]


def test_errors_and_unknown_tools_show_nothing():
    assert present("profit_and_loss", {}, {"error": "boom"}) == []
    assert present("get_business_profile", {}, {"name": "x"}) == []
    assert present("run_sql", {}, {"columns": ["a"], "rows": []}) == []


def test_rows_link_to_the_record_on_its_page():
    args, result = contract.SAMPLE_RESULTS["outstanding_invoices"]
    table = next(
        p for n, p in present("outstanding_invoices", args, result) if n == "table"
    )
    assert table.row_links == ["/invoices?invoice=i-1"]  # type: ignore[attr-defined]


def test_follow_ups_drop_repeats_and_the_question_itself():
    items = [
        FollowUp(label="Revenue", prompt="What is my revenue?"),
        FollowUp(label="Revenue again", prompt="what is my revenue"),
        FollowUp(label="Expenses", prompt="What are my biggest expenses?"),
        FollowUp(label="Cash", prompt="How much cash do I have?"),
    ]
    cleaned = clean_follow_ups(items, "What is my revenue?")
    assert cleaned is not None
    assert [i.label for i in cleaned.items] == ["Expenses", "Cash"]
    assert clean_follow_ups(items[:2], "What is my revenue?") is None


def test_a_clarifying_question_needs_two_to_four_options():
    Clarify(question="Which period?", options=[{"label": "A"}, {"label": "B"}])
    with pytest.raises(ValidationError):
        Clarify(question="Which period?", options=[{"label": "A"}])
