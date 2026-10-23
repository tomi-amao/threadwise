"""A per-user limit on how fast the assistant can be asked.

A sliding window kept in this process's memory: simple, and right for one server. With
several servers each keeps its own count, so a user could get that many times the limit;
move the counts to the database or Redis if that ever matters. The limit protects the
model bill and the quota, not security: tenancy never depends on it.
"""

import math
import time
from collections import defaultdict, deque
from typing import Callable


class SlidingWindowLimiter:
    def __init__(
        self, limit: int, window_s: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.limit = limit
        self.window_s = window_s
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def hit(self, key: str) -> int | None:
        """Count one request: None if allowed, else the seconds to wait."""
        now = self._clock()
        hits = self._hits[key]
        while hits and now - hits[0] >= self.window_s:
            hits.popleft()
        if len(hits) >= self.limit:
            return max(1, math.ceil(self.window_s - (now - hits[0])))
        hits.append(now)
        return None

    def reset(self) -> None:
        self._hits.clear()
