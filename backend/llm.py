"""Talks to Gemini (the "chef"). Falls back to fake results in mock mode."""

import asyncio
import json
import logging
import os
import re

from dotenv import load_dotenv

import prompts

load_dotenv()

log = logging.getLogger("skimatic.llm")

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
MODEL = os.getenv("GEMINI_MODEL", "").strip() or "gemini-3.6-flash"
MOCK = os.getenv("MOCK_LLM", "").strip() == "1" or not API_KEY

ROLES = ("main", "evidence", "background", "counter")

# One Gemini call may take this long before we give up on it (seconds).
TIMEOUT_SECONDS = 60
# Wait this long before the single retry. Tests set it to 0.
RETRY_DELAY_SECONDS = 1.5

_client = None


def _get_client():
    global _client
    if _client is None:
        from google import genai

        _client = genai.Client(api_key=API_KEY)
    return _client


# ---------------------------------------------------------------------------
# Sorting Gemini errors into a few kinds we can act on
# ---------------------------------------------------------------------------

def describe(exc: Exception) -> str:
    """A log-safe description of an error: its type, HTTP code and status only.

    Security gate 7.1: an error MESSAGE could quote the request, i.e. article
    text, and Render keeps logs. So we never log the message itself.
    e.g. "ClientError 400 INVALID_ARGUMENT".
    """
    parts = [type(exc).__name__, getattr(exc, "code", None), getattr(exc, "status", None)]
    return " ".join(str(p) for p in parts if p not in (None, ""))


def error_kind(exc: Exception) -> str:
    """Put an exception into one bucket: quota, rate_limit, bad_key, bad_model,
    timeout, server or other.

    Both quota and rate_limit are HTTP 429. Gemini names the exhausted quota in
    the error text: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" means the
    ~20-a-day free quota is gone (quota); anything else is the per-minute limit
    (rate_limit), which clears by itself after about a minute.

    google-genai raises errors.APIError with .code (HTTP status) and .status
    (e.g. "RESOURCE_EXHAUSTED"). We read them with getattr so this also works
    for fake errors in tests and doesn't crash on plain exceptions.
    """
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    if type(exc).__name__ in ("ReadTimeout", "ConnectTimeout", "TimeoutException"):
        return "timeout"  # httpx timeouts, without importing httpx here

    code = getattr(exc, "code", None)
    status = str(getattr(exc, "status", "") or "").upper()
    text = str(exc).lower()

    if code == 429 or "RESOURCE_EXHAUSTED" in status:
        return "quota" if "perday" in text else "rate_limit"
    # Google answers a wrong key with 400 "API key not valid" (or 401/403).
    if code in (401, 403) or "api key" in text or "api_key_invalid" in text:
        return "bad_key"
    if code == 404 or status == "NOT_FOUND":
        return "bad_model"
    if isinstance(code, int) and 500 <= code < 600:
        return "server"
    return "other"


def is_transient(exc: Exception) -> bool:
    """Worth one retry? Only timeouts and Google-side 5xx.

    Never a 429: a used-up daily quota can't recover, and the per-minute limit
    asks us to wait ~40 s, far longer than our short pause. Retrying either one
    would just spend another call from the daily quota.
    """
    return error_kind(exc) in ("timeout", "server")


# ---------------------------------------------------------------------------
# The actual call
# ---------------------------------------------------------------------------

def analyze_schema():
    """Gemini structured output for /analyze: the reply must be this JSON shape.

    "thesis" comes first (propertyOrdering), so the model writes the article's
    central claim before it labels anything, and role is an enum, so it can't
    invent a fifth role. The prompt still spells out the shape and the server
    still filters every highlight: the schema fixes the shape, not the content.
    """
    from google.genai import types

    string = types.Schema(type=types.Type.STRING)
    highlight = types.Schema(
        type=types.Type.OBJECT,
        properties={
            "paragraph_id": types.Schema(type=types.Type.INTEGER),
            "text": string,
            "role": types.Schema(type=types.Type.STRING, format="enum", enum=list(ROLES)),
        },
        required=["paragraph_id", "text", "role"],
        property_ordering=["paragraph_id", "text", "role"],
    )
    return types.Schema(
        type=types.Type.OBJECT,
        properties={
            "thesis": string,
            "highlights": types.Schema(type=types.Type.ARRAY, items=highlight),
        },
        required=["thesis", "highlights"],
        property_ordering=["thesis", "highlights"],
    )


async def _generate(prompt: str, schema=None) -> str:
    """One raw Gemini request. Returns the reply text. Tests replace this function.

    With a schema, Gemini's structured output holds the reply to that shape;
    without one (simplify, study) it is plain JSON mode as before.
    """
    from google.genai import types

    options = {"response_mime_type": "application/json", "temperature": 0.2}
    if schema is not None:
        options["response_schema"] = schema
    config = types.GenerateContentConfig(**options)
    resp = await asyncio.wait_for(
        _get_client().aio.models.generate_content(model=MODEL, contents=prompt, config=config),
        timeout=TIMEOUT_SECONDS,
    )
    return resp.text


async def ask_json(prompt: str, schema=None) -> dict:
    """Send one prompt to Gemini and parse its JSON reply.

    Retries once after a short pause if the failure looks temporary (timeout,
    5xx). Never retries a 429, a bad key or a missing model: those would fail
    the same way. Only one retry, because the free tier allows ~20 requests a day.
    """
    # Without a schema, call _generate exactly as before (one argument).
    extra = {} if schema is None else {"schema": schema}
    try:
        text = await _generate(prompt, **extra)
    except Exception as e:
        if not is_transient(e):
            raise
        log.warning("Gemini call failed (%s: %s), retrying once", error_kind(e), describe(e))
        await asyncio.sleep(RETRY_DELAY_SECONDS)
        text = await _generate(prompt, **extra)
    return json.loads(text)


# ---------------------------------------------------------------------------
# Mock mode: fake but well-formed answers, no API key needed
# ---------------------------------------------------------------------------

# A sentence ends at . ! or ?, plus citation numbers glued to it like ".1,2",
# when the next sentence starts with a capital (same rule as prompt_lab).
_SENTENCE_END = re.compile(r"[.!?](?:[\d,–-]*\d)?(?=\s+[A-Z(])")


def _sentences(text: str) -> list[str]:
    text = text.strip()
    pieces, start = [], 0
    for end in _SENTENCE_END.finditer(text):
        pieces.append(text[start:end.end()])
        start = end.end()
    pieces.append(text[start:])
    return [p.strip() for p in pieces if p.strip()]


def mock_analyze(paragraphs, title: str = "", context: str = "") -> dict:
    """Fake but well-formed result: first sentence of each paragraph, cycling roles.

    Like the real model it also writes a "thesis", which the server must drop.
    The context paragraph is never highlighted (the real model is told so too).
    """
    highlights = []
    for i, p in enumerate(paragraphs):
        sents = _sentences(p.text)
        if sents:
            highlights.append(
                {"paragraph_id": p.id, "text": sents[0], "role": ROLES[i % len(ROLES)]}
            )
    return {"thesis": "Mock thesis: this article makes one point.", "highlights": highlights}


def mock_simplify(sentence: str) -> dict:
    words = sentence.split()
    return {"core": words[:2] + words[-2:] if len(words) > 4 else words}


# --- mock /study -------------------------------------------------------------
# Built from "key terms": the most repeated longer words of a paragraph. Single
# words only, so the fake questions never copy whole sentences of the article.

_WORD = re.compile(r"[^\W\d_]{4,}")  # letters only, at least 4 of them
_STOPWORDS = {
    "that", "this", "with", "from", "have", "were", "they", "their", "there", "which",
    "what", "when", "where", "while", "would", "could", "should", "about", "after",
    "before", "also", "than", "then", "them", "these", "those", "into", "more", "most",
    "some", "such", "only", "other", "over", "very", "been", "being", "will", "your",
    "said", "says", "many", "much", "each", "even", "just", "because", "between",
    "every", "does", "here", "make", "made", "like", "still", "through", "under", "until",
    "against", "among", "around", "during", "without", "within", "however", "although", "though",
}
# Wrong answers for a mock question when the article has too few other terms.
_FILLERS = ["the weather", "a sports result", "a cooking recipe", "a celebrity wedding"]
# Two templates, so a short article that quizzes one paragraph twice still
# gets two different questions (the server drops duplicate questions).
_QUIZ_TEMPLATES = [
    "Which idea is the part of the article starting \u201c{start}\u2026\u201d mainly about?",
    "Which of these comes up in the part of the article starting \u201c{start}\u2026\u201d?",
]
_PREQUESTION_TEMPLATES = [
    "What does the article say about \u201c{term}\u201d?",
    "Why might \u201c{term}\u201d matter here, and what does the author argue about it?",
    "How does the article explain \u201c{term}\u201d?",
]


def _key_terms(text: str) -> list[str]:
    """Non-stopwords of a paragraph: most repeated first, then longest, then first seen."""
    counts, first_seen, spelling = {}, {}, {}
    for i, match in enumerate(_WORD.finditer(text)):
        word = match.group().lower()
        if word in _STOPWORDS:
            continue
        counts[word] = counts.get(word, 0) + 1
        first_seen.setdefault(word, i)
        spelling.setdefault(word, match.group())
    ranked = sorted(counts, key=lambda w: (-counts[w], -len(w), first_seen[w]))
    return [spelling[w] for w in ranked]


def _spread(items: list, n: int) -> list:
    """n items spread evenly from the start to the end of the list (all if fewer)."""
    if len(items) <= n:
        return list(items)
    if n == 1:
        return [items[0]]
    last = len(items) - 1
    return [items[round(i * last / (n - 1))] for i in range(n)]


def mock_study(paragraphs) -> dict:
    """Fake but well-formed /study answer, the same every time for the same article.

    Like a lazy model, it always puts the right answer first: the server's
    shuffle is what moves it, so mock mode exercises that code too.
    """
    # One (paragraph, key term) pair per paragraph, each term used once.
    picks, used = [], set()
    for p in paragraphs:
        for term in _key_terms(p.text):
            if term.lower() not in used:
                used.add(term.lower())
                picks.append((p, term))
                break
    # Short articles: take a second term from the same paragraphs.
    if len(picks) < 5:
        for p in paragraphs:
            for term in _key_terms(p.text):
                if term.lower() not in used:
                    used.add(term.lower())
                    picks.append((p, term))
                    break
    order = {p.id: i for i, p in enumerate(paragraphs)}
    picks.sort(key=lambda pick: order[pick[0].id])  # questions follow the article
    all_terms = [term for _, term in picks]

    prequestions = [
        {"question": _PREQUESTION_TEMPLATES[i % 3].format(term=term), "paragraph_id": p.id}
        for i, (p, term) in enumerate(_spread(picks, 3))
    ]

    quiz = []
    for i, (p, term) in enumerate(_spread(picks, 5)):
        start = " ".join(p.text.split()[:4])
        lowered = p.text.lower()
        # Wrong answers: terms of other paragraphs that this paragraph never uses.
        wrong = [t for t in all_terms if t != term and t.lower() not in lowered]
        options = [term] + (wrong + _FILLERS)[:3]
        quiz.append({
            "question": _QUIZ_TEMPLATES[i % 2].format(start=start),
            "options": options,
            "answer": 0,
            "explanation": f"That part keeps coming back to \u201c{term}\u201d; the other options belong elsewhere or not at all.",
            "paragraph_id": p.id,
        })
    return {"prequestions": prequestions, "quiz": quiz}


def analyze_prompt(paragraphs, title: str = "", context: str = "") -> str:
    """The /analyze prompt for one chunk. `context` is the article's first paragraph,
    shown read-only to chunks that don't contain it."""
    return prompts.ANALYZE_PROMPT.format(
        title=prompts.format_title(title),
        paragraphs=prompts.format_paragraphs(paragraphs, context=context),
    )


async def analyze(paragraphs, title: str = "", context: str = "") -> dict:
    """Highlights (and a "thesis", which only the server sees) for one chunk."""
    if MOCK:
        return mock_analyze(paragraphs, title=title, context=context)
    return await ask_json(analyze_prompt(paragraphs, title, context), schema=analyze_schema())


async def simplify(sentence: str) -> dict:
    if MOCK:
        return mock_simplify(sentence)
    return await ask_json(prompts.SIMPLIFY_PROMPT.format(sentence=sentence))


async def study(paragraphs) -> dict:
    """Pre-questions and a quiz for one article: ONE Gemini call (or a mock answer)."""
    if MOCK:
        return mock_study(paragraphs)
    prompt = prompts.STUDY_PROMPT.format(paragraphs=prompts.format_paragraphs(paragraphs))
    return await ask_json(prompt)
