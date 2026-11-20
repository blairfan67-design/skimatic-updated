"""Clean up what Gemini returns before it reaches the extension.

The extension finds sentences on the page by exact text match. Anything we
return that isn't copied word for word silently never shows up, so every
highlight and every /simplify piece goes through these filters.
(Ported from the good parts of standalone/validator.py.)
"""

import hashlib
import random
import re
import unicodedata

ROLES = {"main", "evidence", "background", "counter"}
MAX_PER_PARAGRAPH = 2


def find_span(needle: str, haystack: str, start: int = 0):
    """Find needle in haystack, forgiving differences in whitespace only.

    Returns (start, end) of the matching piece of *haystack*, or None.
    We always return the haystack's own characters, so "Prices rose" can match
    "Prices  rose" and we hand back "Prices  rose": still an exact substring of
    the page. This matters for the cache (its key ignores whitespace) and for a
    model that tidies up double spaces or line breaks.
    """
    exact = haystack.find(needle, start)
    if exact != -1:
        return exact, exact + len(needle)
    words = needle.split()
    if not words:
        return None
    match = re.compile(r"\s+".join(map(re.escape, words))).search(haystack, start)
    return (match.start(), match.end()) if match else None


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    """True if [start, end) shares at least one character with any span."""
    return any(start < s_end and s_start < end for s_start, s_end in spans)


def as_paragraph_id(pid):
    """The paragraph id as an int, or None if it isn't a whole number.

    Models sometimes quote ids ("0") or write them as floats (0.0); the old
    pydantic check accepted those, so we do too. bool is a subclass of int but
    True is not a paragraph id, and a list id like [0] can't be looked up.
    """
    if isinstance(pid, bool):
        return None
    if isinstance(pid, int):
        return pid
    if isinstance(pid, float) and pid.is_integer():
        return int(pid)
    # Only ASCII 0-9: str.isdigit() also accepts superscripts like "²",
    # which int() then rejects with a crash after the Gemini call is spent.
    if isinstance(pid, str) and re.fullmatch(r"[0-9]+", pid.strip()):
        return int(pid.strip())
    return None


def clean_highlights(raw: list, paragraphs) -> list[dict]:
    """Keep only highlights the extension can paint, in article order.

    Rules, applied in the model's order (its first picks win):
      - valid role and a paragraph_id that was in the request
      - non-empty text that appears exactly in that paragraph (whitespace may differ;
        we then return the paragraph's own spelling)
      - no duplicates and no overlap with an already-kept highlight
      - at most MAX_PER_PARAGRAPH per paragraph
    """
    order = {p.id: i for i, p in enumerate(paragraphs)}  # paragraph id -> position
    text_of = {p.id: p.text for p in paragraphs}
    spans: dict[int, list[tuple[int, int]]] = {}  # paragraph id -> kept (start, end)
    kept = []

    for h in raw if isinstance(raw, list) else []:
        if not isinstance(h, dict):
            continue
        pid, role, text = as_paragraph_id(h.get("paragraph_id")), h.get("role"), h.get("text")
        if pid not in text_of:  # None (not a whole number) is never in text_of
            continue
        if role not in ROLES or not isinstance(text, str) or not text.strip():
            continue  # "" is a substring of everything, so reject it explicitly
        span = find_span(text.strip(), text_of[pid])
        if span is None:
            continue  # paraphrased: the extension could never find it
        start, end = span
        text = text_of[pid][start:end]  # the page's own characters
        taken = spans.setdefault(pid, [])
        if len(taken) >= MAX_PER_PARAGRAPH or _overlaps(start, end, taken):
            continue  # duplicates overlap themselves, so this drops them too
        taken.append((start, end))
        kept.append((order[pid], start, {"paragraph_id": pid, "text": text, "role": role}))

    kept.sort(key=lambda item: (item[0], item[1]))  # article order reads nicer
    return [h for _, _, h in kept]


def clean_core(raw: list, sentence: str) -> list[str]:
    """Keep /simplify pieces that are non-empty, exact, in reading order, not overlapping.

    We walk through the sentence with a cursor: each piece must be found
    after the end of the previous one, otherwise it is dropped. As above,
    whitespace may differ and we return the sentence's own characters.
    """
    core = []
    cursor = 0
    for piece in raw if isinstance(raw, list) else []:
        if not isinstance(piece, str) or not piece.strip():
            continue
        span = find_span(piece.strip(), sentence, cursor)
        if span is None:
            continue  # not in the sentence, or out of order / overlapping
        core.append(sentence[span[0]:span[1]])
        cursor = span[1]
    return core


# ---------------------------------------------------------------------------
# /study: pre-questions and a multiple-choice quiz
# ---------------------------------------------------------------------------
# These are AI-written questions, not copied sentences, so there is no exact
# match to check. Instead every field is checked for shape and size, and
# anything odd is dropped (never a crash: the Gemini call is already spent).

MAX_PREQUESTIONS = 3
MAX_QUIZ = 5
MAX_QUESTION_CHARS = 200
MAX_OPTION_CHARS = 120
MAX_EXPLANATION_CHARS = 200
N_OPTIONS = 4

# A real-looking HTML tag: a known tag name, then only name=value attributes,
# like <b>, </p>, <br/> or <img src=x onerror=...>. Ordinary text such as
# "a<b and c>d" or "3 < 5" is left alone (a looser pattern ate it on maths/code
# articles). A tag that slips through is harmless: the panel uses textContent.
_TAG_NAMES = (
    "a|abbr|article|aside|audio|b|base|blockquote|body|br|button|caption|cite|code|col|"
    "details|div|em|embed|figure|font|footer|form|frame|h[1-6]|head|header|hr|html|i|"
    "iframe|img|input|label|li|link|main|mark|meta|nav|object|ol|option|p|pre|q|s|"
    "section|select|small|source|span|strong|sub|summary|sup|svg|table|tbody|td|"
    "template|textarea|th|thead|title|tr|u|ul|video"
)
_ATTR = r"""\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)"""
_TAG = re.compile(rf"</?(?:{_TAG_NAMES})(?:{_ATTR})*\s*/?>|<!--.*?-->", re.IGNORECASE)
# Script/style tags carry code, not words: the whole item is dropped instead of
# keeping their contents as text.
_CODE_TAG = re.compile(r"<\s*/?\s*(?:script|style)\b", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# Invisible "format" characters (zero-width space, bidi overrides like U+202E, BOM...).
# They can make two options look identical, or make "siraP" display as "Paris".
# ZWNJ/ZWJ (U+200C/U+200D) are kept: Persian, Indic scripts and emoji need them.
_KEEP_FORMAT = {"\u200c", "\u200d"}


def _drop_format_chars(value: str) -> str:
    return "".join(ch for ch in value
                   if ch in _KEEP_FORMAT or unicodedata.category(ch) != "Cf")


def clean_text(value) -> str:
    """A plain, trimmed, single-line string, or "" if value isn't a usable string.

    The panel shows everything with textContent, so HTML could never run anyway;
    stripping tags just keeps a hijacked answer from showing "<b>" to the reader.
    Text with a <script> or <style> tag comes back as "", so its item is dropped.
    """
    if not isinstance(value, str) or _CODE_TAG.search(value):
        return ""
    value = _CONTROL.sub(" ", _TAG.sub("", _drop_format_chars(value)))
    return re.sub(r"\s+", " ", value).strip()


def _clean_option(value) -> str:
    """Like clean_text, but an option that is ONLY a tag ("<b>" on an article about
    HTML) is kept as written: the panel shows it with textContent, so it's safe,
    and stripping it would empty the option and drop the whole question."""
    if isinstance(value, str) and not _CODE_TAG.search(value):
        bare = _CONTROL.sub(" ", _drop_format_chars(value)).strip()
        if _TAG.fullmatch(bare):
            return bare
    return clean_text(value)


def shorten(text: str, limit: int) -> str:
    """Cut text to at most `limit` characters at a word boundary, ending with an ellipsis."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,;:.") + "…"


def _question_key(question: str) -> str:
    """Two questions that differ only in case, spacing, punctuation or look-alike
    characters (NFKC: full-width letters, ligatures) are the same question."""
    text = _drop_format_chars(unicodedata.normalize("NFKC", question)).lower()
    return re.sub(r"[\s?.!,;:]+", " ", text).strip()


def _option_key(option: str) -> str:
    """Like _question_key ("Paris" and "Paris." are the same choice), but punctuation
    between digits counts: "2:1", "2.1" and "2,1" are different answers."""
    text = _drop_format_chars(unicodedata.normalize("NFKC", option)).lower()
    text = re.sub(r"(?<!\d)[?.!,;:]+|[?.!,;:]+(?!\d)", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def shuffle_options(question: str, options: list[str], answer: int) -> tuple[list[str], int]:
    """Shuffle the options, the same way every time for the same question.

    Models like to put the right answer first, which a reader soon learns to
    exploit. The seed is a hash of the question, so the order is stable (the
    same quiz looks the same on a cache hit or after a restart) and the
    answer index follows its option.
    """
    seed = int(hashlib.sha256(question.encode("utf-8")).hexdigest()[:16], 16)
    order = list(range(len(options)))
    random.Random(seed).shuffle(order)
    return [options[i] for i in order], order.index(answer)


def _clean_prequestion(item, ids: set) -> dict | None:
    if not isinstance(item, dict):
        return None
    pid = as_paragraph_id(item.get("paragraph_id"))
    question = clean_text(item.get("question"))
    if pid not in ids or not question or len(question) > MAX_QUESTION_CHARS:
        return None
    return {"question": question, "paragraph_id": pid}


def _clean_quiz_item(item, ids: set) -> dict | None:
    if not isinstance(item, dict):
        return None
    pid = as_paragraph_id(item.get("paragraph_id"))
    question = clean_text(item.get("question"))
    if pid not in ids or not question or len(question) > MAX_QUESTION_CHARS:
        return None

    raw_options = item.get("options")
    if not isinstance(raw_options, list) or len(raw_options) != N_OPTIONS:
        return None
    options = [_clean_option(o) for o in raw_options]
    if any(not o or len(o) > MAX_OPTION_CHARS for o in options):
        return None
    if len({_option_key(o) for o in options}) != N_OPTIONS:
        return None  # two identical options: one of them can't be the only right answer

    # Same id rules as paragraph ids: 1, 1.0 and "1" are fine, True and 1.5 are not.
    answer = as_paragraph_id(item.get("answer"))
    if answer is None or not 0 <= answer < N_OPTIONS:
        return None

    # An overlong explanation is shortened, not dropped: it is only a hint, and
    # dropping the whole question for it would waste part of a paid call.
    explanation = shorten(clean_text(item.get("explanation")), MAX_EXPLANATION_CHARS)
    if not explanation:
        return None

    options, answer = shuffle_options(question, options, answer)
    return {"question": question, "options": options, "answer": answer,
            "explanation": explanation, "paragraph_id": pid}


def clean_study(raw, paragraphs) -> dict:
    """Keep only well-formed pre-questions and quiz items, in the model's order.

    Only the listed keys are copied, so extra fields a hijacked answer adds
    never reach the extension. paragraph_id must be one of the paragraphs the
    model was shown. Duplicate questions are dropped; the lists are capped.
    """
    ids = {p.id for p in paragraphs}
    raw = raw if isinstance(raw, dict) else {}
    result = {}
    for field, clean_one, cap in (("prequestions", _clean_prequestion, MAX_PREQUESTIONS),
                                  ("quiz", _clean_quiz_item, MAX_QUIZ)):
        items = raw.get(field)
        kept, seen = [], set()
        for item in items if isinstance(items, list) else []:
            cleaned = clean_one(item, ids)
            if cleaned is None or _question_key(cleaned["question"]) in seen:
                continue
            seen.add(_question_key(cleaned["question"]))
            kept.append(cleaned)
            if len(kept) == cap:
                break
        result[field] = kept
    return result
