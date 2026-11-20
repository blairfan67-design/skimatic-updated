"""The "kitchen": receives articles from the extension, asks the LLM, returns highlights.

Run locally:  uvicorn main:app --reload --port 8000
API shape:    see docs/API_CONTRACT.md
"""

import asyncio
import logging
import math
import os
import re
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import cache
import filters
import llm
import prompts
import ratelimit

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("skimatic")

# 4.2 The interactive API docs (/docs, /redoc, /openapi.json) list every endpoint
# and field to anyone. Off by default; set ENABLE_DOCS=1 to use them locally.
DOCS_ON = os.getenv("ENABLE_DOCS", "").strip() == "1"
app = FastAPI(
    title="Skimatic API",
    docs_url="/docs" if DOCS_ON else None,
    redoc_url="/redoc" if DOCS_ON else None,
    openapi_url="/openapi.json" if DOCS_ON else None,
)

# --- Security gate item 2 ---------------------------------------------------
# 2.2 Reject oversized bodies BEFORE reading them. Without this, FastAPI reads
# and parses the whole body (5 MB, 100 MB...) into memory before our own limits
# run, so a few large requests could exhaust a small server. The biggest real
# request (60,000 characters of article text) is well under 1 MB.
MAX_BODY_BYTES = 1_000_000
TOO_LARGE = {"detail": "This request is too large."}


class BodySizeLimit:
    """Plain ASGI middleware: 413 if the body is (or turns out to be) too big."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        # Fast path: the client told us the size up front.
        length = dict(scope.get("headers") or []).get(b"content-length")
        if length is not None:
            try:
                too_big = int(length) > self.max_bytes
            except ValueError:
                too_big = True  # a garbled Content-Length is not worth parsing
            if too_big:
                return await JSONResponse(TOO_LARGE, status_code=413)(scope, receive, send)

            return await self.app(scope, receive, send)

        # Slow path: no Content-Length (chunked upload). Read the body ourselves,
        # stopping as soon as it passes the limit, then hand the (small) body on.
        body, more = b"", True
        while more:
            message = await receive()
            if message["type"] != "http.request":  # client went away
                return
            body += message.get("body", b"")
            more = message.get("more_body", False)
            if len(body) > self.max_bytes:
                return await JSONResponse(TOO_LARGE, status_code=413)(scope, receive, send)

        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()  # after the body: wait for disconnect as usual

        await self.app(scope, replay, send)


app.add_middleware(BodySizeLimit, max_bytes=MAX_BODY_BYTES)


# 2.1 Malformed requests get one plain sentence back. FastAPI's default 422 body
# lists internal field paths and ECHOES THE WHOLE INPUT (a 25,000-character
# sentence came back in full), which reveals the framework and wastes bandwidth.
@app.exception_handler(RequestValidationError)
async def bad_request_shape(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422, content={"detail": "The request wasn't in the expected format."}
    )


# 5.1 CORS: only Chrome extensions may call us from a browser. The extension
# itself doesn't even need this (its background worker has host permission, so
# Chrome lets it through without CORS), but allowing "*" let ANY website a
# visitor opens call this server and spend the Gemini quota. Set EXTENSION_ID
# (from chrome://extensions) to allow only our own extension.
EXTENSION_ID = os.getenv("EXTENSION_ID", "").strip()
EXTENSION_ORIGINS = (
    rf"chrome-extension://{re.escape(EXTENSION_ID)}" if EXTENSION_ID
    else r"chrome-extension://[a-p]{32}"  # any extension id (32 letters a-p)
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=EXTENSION_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

Role = Literal["main", "evidence", "background", "counter"]

# Limits. Above MAX_TOTAL_CHARS the prompt gets huge and slow; 200 paragraphs is
# far more than any real article.
MAX_PARAGRAPHS = 200
MAX_TOTAL_CHARS = 60_000
MAX_MAIN = 3  # "main" highlights per article (the prompt asks for 1-3)
# Very long articles are split so Gemini's JSON reply doesn't get cut off.
# The reply grows with the amount of text, not the number of paragraphs, so we
# split on size. Every chunk is one call from the ~20-a-day free quota, so the
# limits are generous: anything the extension sends (<= 80 paragraphs) under
# 20,000 characters is 1 call, and the biggest allowed article is usually 3
# calls (up to 5 in the worst case: several ~21,000-character paragraphs
# between short ones can't share a chunk under CHUNK_MAX_CHARS).
CHUNK_CHARS = 20_000  # aim for about this many characters per Gemini call...
CHUNK_MAX_CHARS = 24_000  # ...and never more than this (unless one paragraph is longer)
CHUNK_MAX_PARAGRAPHS = 80  # and at most this many paragraphs per call
PARALLEL_CALLS = 2  # chunks sent at the same time (more trips the per-minute limit)

# Same article or sentence again -> answer from memory, no Gemini call.
ANALYZE_CACHE = cache.LRUCache(256)
SIMPLIFY_CACHE = cache.LRUCache(256)
# /study answers are AI-written questions, not article sentences (see HANDOFF.md, Privacy).
STUDY_CACHE = cache.LRUCache(256)
# /study is always ONE Gemini call, so it only sees the start of a very long
# article: about the size of one /analyze chunk, which Gemini answers reliably.
STUDY_MAX_CHARS = 25_000


class Paragraph(BaseModel):
    id: int
    text: str


class AnalyzeRequest(BaseModel):
    paragraphs: list[Paragraph]  # size limits are checked in check_limits() for a readable message


class Highlight(BaseModel):
    paragraph_id: int
    text: str
    role: Role


class AnalyzeResponse(BaseModel):
    highlights: list[Highlight]


class StudyRequest(BaseModel):
    paragraphs: list[Paragraph]  # same shape and limits as /analyze


class PreQuestion(BaseModel):
    question: str
    paragraph_id: int


class QuizItem(BaseModel):
    question: str
    options: list[str]
    answer: int
    explanation: str
    paragraph_id: int


class StudyResponse(BaseModel):
    prequestions: list[PreQuestion]
    quiz: list[QuizItem]


class SimplifyRequest(BaseModel):
    sentence: str = Field(..., max_length=2000)


class SimplifyResponse(BaseModel):
    core: list[str]


# ---------------------------------------------------------------------------
# Errors: show the reader a human message, keep the details in the server log
# ---------------------------------------------------------------------------

ERRORS = {
    "quota": (503, "The AI's daily limit is used up. Try again later or use another API key."),
    "rate_limit": (503, "Too many AI requests right now. Wait a minute and try again."),
    # 4.1 Config problems get a neutral public message: anyone can call the
    # backend, so it must not name settings or file paths. The fix-it hint goes
    # to the server log instead (see FIX_HINTS), where only the team reads it.
    "bad_key": (502, "The AI isn't available right now. Try again later."),
    "bad_model": (502, "The AI isn't available right now. Try again later."),
}
GENERIC_ERROR = (502, "The AI didn't answer properly. Try again.")
FIX_HINTS = {
    "bad_key": "check GEMINI_API_KEY in backend/.env (or the Render environment)",
    "bad_model": "check GEMINI_MODEL in backend/.env (or the Render environment)",
}


def llm_failure(exc: Exception) -> HTTPException:
    """Turn any LLM exception into an HTTPException with a safe, friendly message."""
    kind = llm.error_kind(exc)
    log.error("LLM call failed (%s): %s", kind, llm.describe(exc))  # type/code only, never the text
    if kind in FIX_HINTS:
        log.error("To fix: %s", FIX_HINTS[kind])
    status, detail = ERRORS.get(kind, GENERIC_ERROR)
    return HTTPException(status_code=status, detail=detail)


def model_name() -> str:
    """Part of every cache key, so mock answers never pose as real ones."""
    return "mock" if llm.MOCK else llm.MODEL


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    # 4.3 Only what the extension needs: no model name or other config details.
    return {"status": "ok", "mock": llm.MOCK}


def check_limits(paragraphs: list[Paragraph]) -> list[Paragraph]:
    """Reject requests we can't or shouldn't send; return the non-blank paragraphs.

    Blank paragraphs are dropped so they never cost part of a Gemini call, and
    an all-blank request is a 400 instead of a wasted call.
    """
    if len(paragraphs) > MAX_PARAGRAPHS:
        raise HTTPException(
            413, f"This article has too many paragraphs ({len(paragraphs)}, max {MAX_PARAGRAPHS})."
        )
    paragraphs = [p for p in paragraphs if p.text.strip()]
    if not paragraphs:
        raise HTTPException(400, "No paragraphs were sent. Is there an article on this page?")
    total = sum(len(p.text) for p in paragraphs)
    if total > MAX_TOTAL_CHARS:
        raise HTTPException(
            413, f"This article is too long ({total:,} characters, max {MAX_TOTAL_CHARS:,})."
        )
    return paragraphs


def fill_chunks(paragraphs: list[Paragraph], budget: int) -> list[list[Paragraph]]:
    """Fill chunks in order, starting a new one when the next paragraph would
    take the chunk over `budget` characters or CHUNK_MAX_PARAGRAPHS paragraphs.
    A single paragraph longer than `budget` gets a chunk of its own."""
    chunks, current, chars = [], [], 0
    for p in paragraphs:
        if current and (chars + len(p.text) > budget or len(current) >= CHUNK_MAX_PARAGRAPHS):
            chunks.append(current)
            current, chars = [], 0
        current.append(p)
        chars += len(p.text)
    if current:
        chunks.append(current)
    return chunks


def smallest_budget(paragraphs: list[Paragraph], n_chunks: int) -> int:
    """The smallest character budget for which fill_chunks needs <= n_chunks chunks.

    A bigger budget never needs more chunks, so we can binary search it.
    """
    total_chars = sum(len(p.text) for p in paragraphs)
    longest = max(len(p.text) for p in paragraphs)
    low = max(longest, math.ceil(total_chars / n_chunks))  # no budget below this can work
    high = max(low, total_chars)  # everything fits, apart from the paragraph cap
    while low < high:
        middle = (low + high) // 2
        if len(fill_chunks(paragraphs, middle)) <= n_chunks:
            high = middle
        else:
            low = middle + 1
    return low


def split_into_chunks(paragraphs: list[Paragraph]) -> list[list[Paragraph]]:
    """One chunk for normal articles; as few, evenly sized chunks as we can for long ones.

    Chunks are balanced by characters, not paragraph count: with a mix of short
    and long paragraphs, equal counts could put 35,000 characters in one call
    and get its reply cut off. Even sizes (e.g. 90 -> 45 + 45, not 80 + 10)
    also give every call similar context.
    """
    total_chars = sum(len(p.text) for p in paragraphs)
    n_chunks = max(
        1,
        math.ceil(total_chars / CHUNK_CHARS),
        math.ceil(len(paragraphs) / CHUNK_MAX_PARAGRAPHS),
    )
    longest = max(len(p.text) for p in paragraphs)
    while True:
        budget = smallest_budget(paragraphs, n_chunks)
        # Only spend an extra call when the chunks would really be too big.
        if budget <= max(CHUNK_MAX_CHARS, longest):
            return fill_chunks(paragraphs, budget)
        n_chunks += 1


# ---------------------------------------------------------------------------
# Never pay twice for the same question
# ---------------------------------------------------------------------------

# Questions being asked right now: cache key -> the running task.
_IN_FLIGHT: dict[str, asyncio.Task] = {}


async def ask_once(key: str, make_call):
    """Run make_call(), unless the same question is already on its way to Gemini.

    A double-clicked Analyze button sends two identical requests before the
    first answer is cached. The second one waits for the first one's answer
    instead of spending another call. Safe without locks: one event loop.
    """
    task = _IN_FLIGHT.get(key)
    if task is None:
        task = asyncio.ensure_future(make_call())
        _IN_FLIGHT[key] = task
        task.add_done_callback(lambda _: _IN_FLIGHT.pop(key, None))
    # shield: if one reader closes the tab, the other still gets the answer.
    return await asyncio.shield(task)


def chunk_key(chunk: list[Paragraph]) -> str:
    """Cache key for one chunk. Whitespace is ignored: the filters forgive it too."""
    return cache.make_key(
        model_name(), prompts.ANALYZE_PROMPT, [[p.id, cache.normalize(p.text)] for p in chunk]
    )


async def ask_chunk(chunk: list[Paragraph], key: str) -> list[dict]:
    """One Gemini call for one chunk. Caches the cleaned answer if it has anything in it."""
    ratelimit.take_ai_call()  # 6.3 optional daily cap for the whole server
    result = await llm.analyze(chunk)
    raw = result.get("highlights", []) if isinstance(result, dict) else []
    highlights = filters.clean_highlights(raw, chunk)
    if highlights:  # an empty answer is a miss worth retrying, not something to remember
        ANALYZE_CACHE.put(key, cache.to_positions(highlights, chunk))  # 7.2: no text kept
    return highlights


async def analyze_chunk(chunk, limiter: asyncio.Semaphore, limit_errors: list) -> tuple[list[dict], bool]:
    """Highlights for one chunk, from the cache or from Gemini. Returns (highlights, was_cached).

    Each chunk is cached on its own, so if one chunk of a long article fails,
    analyzing again only pays for that chunk.
    """
    key = chunk_key(chunk)
    positions = ANALYZE_CACHE.get(key)
    was_cached = positions is not None
    # 7.2 The cache keeps only positions; cut the sentences back out of the
    # article this request just sent.
    highlights = cache.from_positions(positions, chunk) if was_cached else None
    if not was_cached:
        async with limiter:
            if limit_errors:  # an earlier chunk hit a 429: more calls would fail too
                raise limit_errors[0]
            try:
                highlights = await ask_once(key, lambda: ask_chunk(chunk, key))
            except Exception as e:
                if llm.error_kind(e) in ("quota", "rate_limit"):
                    limit_errors.append(e)
                raise
    # Filter again against *this* request: the cached answer may have come from
    # a request with different spacing, and this maps it onto ours.
    return filters.clean_highlights(highlights, chunk), was_cached


async def analyze_in_chunks(paragraphs: list[Paragraph]) -> list[dict]:
    """Ask about every chunk (PARALLEL_CALLS at a time) and merge the answers.

    Highlights keep their original paragraph ids because each chunk is
    filtered against its own paragraphs. If some chunks fail we still return
    the others (their quota is already spent) and log how many are missing;
    the reader can press Analyze again to fill the gap. If all fail, raise.
    """
    chunks = split_into_chunks(paragraphs)
    limiter = asyncio.Semaphore(PARALLEL_CALLS)
    limit_errors: list[Exception] = []
    results = await asyncio.gather(
        *(analyze_chunk(c, limiter, limit_errors) for c in chunks), return_exceptions=True
    )

    merged, errors, from_cache = [], [], 0
    for result in results:
        if isinstance(result, BaseException):
            errors.append(result)
            continue
        highlights, was_cached = result
        merged.extend(highlights)
        from_cache += was_cached

    if len(errors) == len(chunks):
        # Report the daily/minute limit if any chunk hit it: "try again" would
        # just send the reader into the same wall.
        raise next((e for e in errors if llm.error_kind(e) in ("quota", "rate_limit")), errors[0])
    if errors:
        log.warning("analyze: %d of %d chunks failed (%s); returning the rest",
                    len(errors), len(chunks), llm.describe(errors[0]))
    log.info("analyze: %d paragraphs, %d chunk(s), %d from cache",
             len(paragraphs), len(chunks), from_cache)
    return merged


# ---------------------------------------------------------------------------
# /analyze and /simplify
# ---------------------------------------------------------------------------

@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest, request: Request):
    paragraphs = check_limits(req.paragraphs)
    # 6.1 Per-IP limit before any Gemini call; a fully cached article is free.
    if any(ANALYZE_CACHE.get(chunk_key(c)) is None for c in split_into_chunks(paragraphs)):
        ratelimit.check("analyze", request)
    try:
        highlights = await analyze_in_chunks(paragraphs)
    except Exception as e:  # LLM down, bad JSON, quota, ...
        raise llm_failure(e)
    return AnalyzeResponse(highlights=[Highlight(**h) for h in cap_main(highlights)])


def cap_main(highlights: list[dict]) -> list[dict]:
    """Keep at most MAX_MAIN 'main' highlights for the whole article.

    Long articles are analyzed in chunks and each chunk may pick its own 1-3
    main points, so the merged answer can have too many. The first ones in
    article order are kept; "Main points only" should stay a short list.
    """
    kept, mains = [], 0
    for h in highlights:
        if h["role"] == "main":
            mains += 1
            if mains > MAX_MAIN:
                continue
        kept.append(h)
    return kept


async def ask_simplify(sentence: str, key: str) -> list[str]:
    """One Gemini call for one sentence. Caches the cleaned answer if it isn't empty."""
    ratelimit.take_ai_call()  # 6.3 optional daily cap for the whole server
    raw = await llm.simplify(sentence)
    core = filters.clean_core(raw.get("core", []) if isinstance(raw, dict) else [], sentence)
    if core:  # an empty answer is a miss worth retrying, not something to remember
        SIMPLIFY_CACHE.put(key, cache.core_to_positions(core, sentence))  # 7.2: no text kept
    return core


@app.post("/simplify", response_model=SimplifyResponse)
async def simplify(req: SimplifyRequest, request: Request):
    if not req.sentence.strip():
        raise HTTPException(400, "No sentence was sent.")
    key = cache.make_key(model_name(), prompts.SIMPLIFY_PROMPT, cache.normalize(req.sentence))

    positions = SIMPLIFY_CACHE.get(key)
    core = cache.core_from_positions(positions, req.sentence) if positions is not None else None
    if core is not None:
        log.info("simplify: cache hit")
    else:
        ratelimit.check("simplify", request)  # 6.1 only uncached sentences count
        log.info("simplify: cache miss")
        try:
            core = await ask_once(key, lambda: ask_simplify(req.sentence, key))
        except Exception as e:
            raise llm_failure(e)

    # Map the answer onto this request's spacing (a cache hit may differ in whitespace).
    return SimplifyResponse(core=filters.clean_core(core, req.sentence))


# ---------------------------------------------------------------------------
# /study: questions before reading, a quiz after (one Gemini call per article)
# ---------------------------------------------------------------------------

MIN_QUIZ = 2  # fewer than this is not worth showing as a quiz


class StudyAnswerTooThin(Exception):
    """The model's answer had fewer than MIN_QUIZ usable quiz questions.

    error_kind() files it under "other", so the reader gets the usual
    "The AI didn't answer properly. Try again."
    """


def study_paragraphs(paragraphs: list[Paragraph]) -> list[Paragraph]:
    """The paragraphs the model sees: from the start, up to STUDY_MAX_CHARS characters.

    Whole paragraphs only, so every paragraph_id it answers with is one the
    page has. A first paragraph longer than the budget is cut, not skipped.
    """
    kept, total = [], 0
    for p in paragraphs:
        if total + len(p.text) > STUDY_MAX_CHARS:
            break
        kept.append(p)
        total += len(p.text)
    if not kept:
        first = paragraphs[0]
        kept = [Paragraph(id=first.id, text=first.text[:STUDY_MAX_CHARS])]
    return kept


def study_key(paragraphs: list[Paragraph]) -> str:
    return cache.make_key(
        model_name(), prompts.STUDY_PROMPT, [[p.id, cache.normalize(p.text)] for p in paragraphs]
    )


async def ask_study(paragraphs: list[Paragraph], key: str) -> dict:
    """One Gemini call; cleans the answer and caches it only if the quiz is usable."""
    ratelimit.take_ai_call()  # 6.3 optional daily cap for the whole server
    result = filters.clean_study(await llm.study(paragraphs), paragraphs)
    if len(result["quiz"]) < MIN_QUIZ:
        raise StudyAnswerTooThin()  # not cached: asking again may go better
    STUDY_CACHE.put(key, result)
    return result


@app.post("/study", response_model=StudyResponse)
async def study(req: StudyRequest, request: Request):
    paragraphs = study_paragraphs(check_limits(req.paragraphs))
    key = study_key(paragraphs)

    result = STUDY_CACHE.get(key)
    if result is not None:
        log.info("study: cache hit")
    else:
        ratelimit.check("study", request)  # 6.1 only uncached articles count
        try:
            result = await ask_once(key, lambda: ask_study(paragraphs, key))
        except Exception as e:
            raise llm_failure(e)
        # Counts only: never the article or the questions (they may paraphrase it).
        log.info("study: cache miss, %d paragraphs sent, %d prequestions, %d quiz items",
                 len(paragraphs), len(result["prequestions"]), len(result["quiz"]))
    return StudyResponse(**result)
