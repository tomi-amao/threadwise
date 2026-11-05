"""A product that arrives after its orders: the lines sold before it are linked to it."""

import asyncio
from typing import Any, Dict, List
from uuid import uuid4

from ai_agent.normalization.persistence import PersistenceService


class Query:
    """Records the calls of one chained query and answers it from a queue."""

    def __init__(self, log: List[Dict[str, Any]], answers: List[List[Dict[str, Any]]]):
        self.log, self.answers = log, answers
        self.calls: List[tuple] = []

    def __getattr__(self, name: str):
        def call(*args: Any, **kwargs: Any):
            self.calls.append((name, args))
            return self

        return call

    def execute(self):
        self.log.append({"calls": self.calls})
        is_select = self.calls[0][0] == "select"
        data = self.answers.pop(0) if is_select and self.answers else []
        return type("Result", (), {"data": data})()


class Client:
    def __init__(self, found: List[List[Dict[str, Any]]]):
        self.log: List[Dict[str, Any]] = []
        self.found = found

    def table(self, name: str) -> Query:
        assert name == "order_line_items"
        return Query(self.log, self.found)


def link(found: List[List[Dict[str, Any]]]):
    service = PersistenceService()
    client = Client(found)
    service._client = client
    entity, product = uuid4(), uuid4()
    count = asyncio.run(service._link_order_lines(entity, "shopify", "p1", product))
    return count, client.log, entity, product


class TestLinkOrderLines:
    def test_unlinked_lines_of_the_product_are_pointed_at_it(self):
        count, log, entity, product = link([[{"id": "l1"}, {"id": "l2"}], []])

        assert count == 2
        names = log[0]["calls"]
        assert ("eq", ("product_external_id", "p1")) in names
        assert ("is_", ("product_id", "null")) in names
        assert ("eq", ("orders.entity_id", str(entity))) in names
        assert ("eq", ("orders.provider", "shopify")) in names
        update = log[1]["calls"]
        assert update[0] == ("update", ({"product_id": str(product)},))
        assert ("in_", ("id", ["l1", "l2"])) in update

    def test_nothing_to_link_writes_nothing(self):
        count, log, _, _ = link([[]])
        assert count == 0
        assert len(log) == 1

    def test_a_failure_does_not_stop_the_product_being_saved(self):
        service = PersistenceService()

        class Broken:
            def table(self, name: str):
                raise RuntimeError("down")

        service._client = Broken()
        assert (
            asyncio.run(service._link_order_lines(uuid4(), "shopify", "p1", uuid4()))
            == 0
        )
