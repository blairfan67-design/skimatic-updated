"""Security gate item 6: stop one person from spending the whole Gemini quota.

There is no login, so without this a simple loop can use up the free tier's
~20 calls a day in a few seconds and the demo fails.

Two guards, both in memory (they reset when the server restarts, which is fine
for one small server):
- check(): per-IP limits, called BEFORE any Gemini call. Requests answered from
  the cache never reach it, so re-opening an article costs nothing.
- take_ai_call(): an optional cap on Gemini calls per day for the whole server
  (DAILY_AI_BUDGET). Off unless set; useful once billing is on.
"""

import os
import time
from collections import defaultdict, deque
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request

# (window in seconds, max requests in that window) per endpoint, per IP.
LIMITS = {
    "analyze": [(60, 5), (3600, 30)],
    "simplify": [(60, 20), (3600, 120)],
    # One call per article, and readers study far fewer articles than they skim.
    "study": [(60, 3), (3600, 20)],
}
TOO_FAST = "You're going too fast. Please wait a minute and try again."

ENABLED = os.getenv("RATE_LIMIT", "1").strip() != "0"
# On Render every visitor arrives through Render's proxy, so the connection IP
# is the proxy's. TRUST_PROXY=1 reads the visitor's IP from X-Forwarded-For
# instead. We take the LAST entry: that's the one Render's proxy added. Earlier
# entries come from the sender and can be faked to dodge the limit. Leave it
# off when the server is reached directly (locally), or anyone could fake it.
TRUST_PROXY = os.getenv("TRUST_PROXY", "").strip() == "1"

MAX_TRACKED_IPS = 10_000  # memory guard: forget idle IPs past this many
_hits: dict[tuple[str, str], deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    if TRUST_PROXY:
        forwarded = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",")]
        forwarded = [p for p in forwarded if p]
        if forwarded:
            return forwarded[-1]
    return request.client.host if request.client else "unknown"


def check(endpoint: str, request: Request, now: float | None = None) -> None:
    """Raise 429 if this IP has used up its requests for `endpoint`; else count one."""
    if not ENABLED:
        return
    now = time.monotonic() if now is None else now
    windows = LIMITS[endpoint]
    longest = max(window for window, _ in windows)

    times = _hits[(endpoint, client_ip(request))]
    while times and now - times[0] >= longest:  # drop requests too old to matter
        times.popleft()
    for window, limit in windows:
        if sum(1 for t in times if now - t < window) >= limit:
            raise HTTPException(429, TOO_FAST, headers={"Retry-After": "60"})
    times.append(now)

    if len(_hits) > MAX_TRACKED_IPS:
        _forget_idle(now, longest)


def _forget_idle(now: float, longest: int) -> None:
    for key in [k for k, t in _hits.items() if not t or now - t[-1] >= longest]:
        del _hits[key]
    if len(_hits) > MAX_TRACKED_IPS:  # still too many: start over rather than grow forever
        _hits.clear()


# --- daily budget for the whole server -----------------------------------------

DAILY_AI_BUDGET = int(os.getenv("DAILY_AI_BUDGET", "0").strip() or 0)  # 0 = no cap
# Gemini's free-tier daily quota resets at midnight Pacific time.
QUOTA_TIMEZONE = ZoneInfo("America/Los_Angeles")
_budget = {"day": None, "used": 0}


class BudgetExhausted(Exception):
    """Looks like Gemini's own daily-quota error, so main.py shows the same
    "daily limit" message for it."""

    code = 429
    status = "RESOURCE_EXHAUSTED"

    def __str__(self):
        return "Local DAILY_AI_BUDGET reached (GenerateRequestsPerDay)"


def take_ai_call() -> None:
    """Count one Gemini call; raise BudgetExhausted if today's budget is used up."""
    if DAILY_AI_BUDGET <= 0:
        return
    today = datetime.now(QUOTA_TIMEZONE).date()
    if _budget["day"] != today:
        _budget.update(day=today, used=0)
    if _budget["used"] >= DAILY_AI_BUDGET:
        raise BudgetExhausted()
    _budget["used"] += 1


def reset() -> None:
    """Forget everything (used by tests)."""
    _hits.clear()
    _budget.update(day=None, used=0)
