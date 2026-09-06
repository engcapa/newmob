"""One monotonic execution budget; artifact collection has a separate budget."""
from __future__ import annotations

import time
from contextlib import contextmanager
from contextvars import ContextVar

_active = ContextVar("qa_case_deadline", default=None)


@contextmanager
def using_deadline(deadline):
    token = _active.set(deadline)
    try:
        yield
    finally:
        _active.reset(token)


def remaining_timeout(default: float) -> float:
    deadline = _active.get()
    return min(default, deadline.remaining()) if deadline else default


class _BudgetClock:
    def __getattr__(self, name):
        return getattr(time, name)

    def sleep(self, seconds):
        deadline = _active.get()
        remaining = deadline.remaining() if deadline else seconds
        time.sleep(min(seconds, remaining))
        if deadline:
            if seconds >= remaining:
                raise CaseTimeout("case execution deadline exceeded")
            deadline.remaining()


budget_time = _BudgetClock()


class CaseTimeout(TimeoutError):
    pass


class Deadline:
    def __init__(self, seconds: float):
        self.expires = time.monotonic() + seconds

    def remaining(self) -> float:
        remaining = self.expires - time.monotonic()
        if remaining <= 0:
            raise CaseTimeout("case execution deadline exceeded")
        return remaining

    def arguments(self, args):
        if isinstance(args, dict):
            args = dict(args)
            args["timeout_sec"] = min(float(args.get("timeout_sec", 10)), self.remaining())
        return args


class BudgetedPage:
    """Clamp explicit Playwright waits as well as defaults to the case budget."""
    def __init__(self, target, deadline: Deadline):
        self._target = target
        self._deadline = deadline

    def __getattr__(self, name):
        target = getattr(self._target, name)
        if not callable(target):
            if hasattr(target, "_impl_obj"):
                return BudgetedPage(target, self._deadline)
            return target

        def call(*args, **kwargs):
            remaining = self._deadline.remaining()
            if "timeout" in kwargs:
                timeout = kwargs["timeout"]
                kwargs["timeout"] = min(timeout or remaining * 1000, remaining * 1000)
            if name == "wait_for_timeout":
                args = (min(args[0], remaining * 1000), *args[1:])
            result = target(*args, **kwargs)
            self._deadline.remaining()
            if hasattr(result, "_impl_obj"):
                return BudgetedPage(result, self._deadline)
            return result
        return call
