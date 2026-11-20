"""Prompt experiments: run the current prompts against test_paragraphs.txt.

    python prompt_lab.py                     # analyze every paragraph in the file, print picks
    python prompt_lab.py --simplify "The committee, after months of debate, approved the bill."
    python prompt_lab.py --score             # analyze once, compare with gold.json (1 Gemini call)
    python prompt_lab.py --score-simplify    # simplify 5 gold sentences, compare with gold_simplify.json
    python prompt_lab.py --score-simplify --limit 10

Paragraphs in test_paragraphs.txt are separated by a blank line. Lines starting
with '#' are comments (use them to label the article type), except two kinds that
give the model the structure the extension sends: "# title: ..." (the article
title) and "# heading: ..." (the section heading of this and the following
paragraphs). --plain ignores both, to compare with runs made without them.
Edit prompts.py, re-run, compare. Write down what worked in docs/PROMPT_NOTES.md.

Quota: the free tier allows ~20 Gemini calls a day. --score costs exactly 1
call, --score-simplify costs --limit calls (default 5). Set MOCK_LLM=1 to try
the script itself without spending any.
"""

import argparse
import asyncio
import json
import re
import statistics
import time
from collections import Counter
from pathlib import Path

import filters
import llm
from main import Paragraph

HERE = Path(__file__).parent


_DIRECTIVE = re.compile(r"#\s*(title|heading):\s*(.*)", re.IGNORECASE)


def load_paragraphs(path: Path, structure: bool = True) -> list[Paragraph]:
    """Paragraphs of a test file; with `structure`, each gets its "# heading:"."""
    blocks = path.read_text(encoding="utf-8").split("\n\n")
    paras, heading = [], ""
    for b in blocks:
        lines = []
        for line in b.splitlines():
            directive = _DIRECTIVE.fullmatch(line.strip())
            if directive and directive.group(1).lower() == "heading":
                heading = directive.group(2).strip()
            if not line.lstrip().startswith("#"):
                lines.append(line)
        t = " ".join(l.strip() for l in lines).strip()
        if t:
            paras.append(Paragraph(id=len(paras), text=t, heading=heading if structure else ""))
    return paras


def load_title(path: Path) -> str:
    """The "# title:" line of a test file, or ""."""
    for line in path.read_text(encoding="utf-8").splitlines():
        directive = _DIRECTIVE.fullmatch(line.strip())
        if directive and directive.group(1).lower() == "title":
            return directive.group(2).strip()
    return ""


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def count_sentences(text: str) -> int:
    """Rough sentence count. A sentence ends at . ! or ? (optionally followed by
    citation numbers like '1,2' or '3–6') and the next one starts with a capital."""
    return len(re.findall(r"[.!?](?:[\d,–-]*\d)?\s+(?=[A-Z(])", text.strip())) + 1


def overlaps_any(gold_text: str, paragraph: str, model_texts: list[str]) -> bool:
    """True if any model highlight shares characters with the gold sentence.

    A lenient match: a model sentence that differs from gold only by a citation
    suffix or a clause boundary still counts here (it is a miss in strict terms).
    """
    g = paragraph.find(gold_text)
    if g == -1:
        return False
    for text in model_texts:
        m = paragraph.find(text)
        if m != -1 and m < g + len(gold_text) and g < m + len(text):
            return True
    return False


def pct(part: float, whole: float) -> str:
    return f"{100 * part / whole:.0f}%" if whole else "n/a"


def highlights_of(result) -> list:
    """The raw highlight list from a Gemini reply, or [] if the reply has an odd shape.

    The call is already paid for by now, so a strange reply must still get
    printed and scored (as 0), not crash the script.
    """
    raw = result.get("highlights", []) if isinstance(result, dict) else []
    return raw if isinstance(raw, list) else []


def report_failed_call(e: Exception) -> None:
    """Print why a call failed, plus the raw reply when it was broken JSON.

    A reply cut off by the length limit is valid-looking text that json.loads
    rejects. The call is already paid for, so show its start (e.doc holds the
    raw text) instead of crashing with a traceback that hides it.
    """
    print(f"call failed: {llm.error_kind(e)}: {type(e).__name__}: {e}")
    if isinstance(e, json.JSONDecodeError):
        print(f"raw reply ({len(e.doc)} chars), start:\n{e.doc[:500]}")


def is_exact(h, by_id: dict) -> bool:
    """True if a raw highlight's text is copied word for word from its paragraph.

    Same id rules as filters.clean_highlights (a list id like [0] can't even
    be looked up), and the text must be a non-empty string.
    """
    if not isinstance(h, dict):
        return False
    pid, text = filters.as_paragraph_id(h.get("paragraph_id")), h.get("text")
    if pid not in by_id:
        return False
    return isinstance(text, str) and text.strip() != "" and text.strip() in by_id[pid]


# ---------------------------------------------------------------------------
# Plain run (the original prompt_lab behaviour)
# ---------------------------------------------------------------------------

def print_thesis(result) -> None:
    """The model's one-sentence thesis (never sent to the extension; shown here
    because a wrong thesis explains wrong roles)."""
    thesis = result.get("thesis") if isinstance(result, dict) else None
    print(f"thesis: {thesis if isinstance(thesis, str) and thesis else '(none)'}\n")


async def run_plain(paras: list[Paragraph], title: str = "") -> None:
    try:
        result = await llm.analyze(paras, title=title)
        print_thesis(result)
        raw = highlights_of(result)
    except Exception as e:
        report_failed_call(e)
        return
    by_id = {p.id: p.text for p in paras}
    ok = bad = 0
    for h in raw:
        exact = is_exact(h, by_id)
        ok += exact
        bad += not exact
        mark = "OK " if exact else "BAD"  # BAD = not copied exactly, extension can't find it
        h = h if isinstance(h, dict) else {"text": repr(h)}
        # str(): the model may send role null or a non-string; don't crash on it.
        print(f"[{mark}] p{h.get('paragraph_id')} {str(h.get('role')):<10} {h.get('text')}")
    print(f"\n{ok} exact, {bad} not exact")


# ---------------------------------------------------------------------------
# --score: /analyze vs gold.json
# ---------------------------------------------------------------------------

def gold_picks(paras: list[Paragraph], gold: list[dict]) -> dict:
    """{(paragraph id, sentence): role} from gold.json, matched to paragraphs by text."""
    id_of = {norm(p.text): p.id for p in paras}
    picks = {}
    for entry in gold:
        pid = id_of.get(norm(entry["paragraph"]))
        if pid is None:
            print(f"warning: a gold paragraph is not in the test file: {entry['paragraph'][:60]}...")
            continue
        for h in entry["highlights"]:
            picks[(pid, norm(h["text"]))] = h["role"]
    return picks


async def score_analyze(paras: list[Paragraph], gold: list[dict], title: str = "") -> None:
    # One call for all paragraphs on purpose (no chunking): 21 paragraphs fit easily.
    start = time.perf_counter()
    try:
        result = await llm.analyze(paras, title=title)
    except Exception as e:
        report_failed_call(e)
        return
    seconds = time.perf_counter() - start
    raw = highlights_of(result)
    if not raw:  # show what came back, so the spent call still teaches something
        print("warning: no highlight list in the reply:", json.dumps(result, default=str)[:500], "\n")

    by_id = {p.id: p.text for p in paras}
    exact = sum(is_exact(h, by_id) for h in raw)
    kept = filters.clean_highlights(raw, paras)  # exactly what the extension would get
    model = {(h["paragraph_id"], norm(h["text"])): h["role"] for h in kept}
    gold_set = gold_picks(paras, gold)

    hits = model.keys() & gold_set.keys()
    texts_in = {}  # paragraph id -> model highlight texts
    for h in kept:
        texts_in.setdefault(h["paragraph_id"], []).append(h["text"])
    touched = sum(overlaps_any(text, by_id[pid], texts_in.get(pid, [])) for pid, text in gold_set)
    same_role = sum(model[k] == gold_set[k] for k in hits)
    total_sentences = sum(count_sentences(p.text) for p in paras)
    model_roles = Counter(model.values())
    gold_roles = Counter(gold_set.values())

    print(f"Analyze score: {len(paras)} paragraphs, 1 call, {seconds:.1f} s\n")
    print_thesis(result)
    print(f"  exact-match rate      {exact}/{len(raw)} = {pct(exact, len(raw))}   (target >= 90%)")
    print(f"  kept after filter     {len(kept)}")
    print(f"  sentences highlighted {len(kept)}/{total_sentences} = {pct(len(kept), total_sentences)}"
          f"   (gold: {pct(len(gold_set), total_sentences)}, target 10-20%)")
    print(f"  precision vs gold     {len(hits)}/{len(model)} = {pct(len(hits), len(model))}")
    print(f"  recall vs gold        {len(hits)}/{len(gold_set)} = {pct(len(hits), len(gold_set))}")
    print(f"  gold touched (lenient){touched:>3}/{len(gold_set)} = {pct(touched, len(gold_set))}"
          "   (any overlap counts)")
    print(f"  same role when both   {same_role}/{len(hits)} = {pct(same_role, len(hits))}")
    print("\n  role         model  gold")
    for role in ("main", "evidence", "background", "counter"):
        print(f"  {role:<12} {model_roles[role]:>5} {gold_roles[role]:>5}")
    print("\n  (gold over-uses 'main'; the spec wants 1-3 per article, see HANDOFF.md)")
    if llm.MOCK:
        print("  (mock mode: these numbers only show the script works, not prompt quality)")


# ---------------------------------------------------------------------------
# --score-simplify: /simplify vs gold_simplify.json
# ---------------------------------------------------------------------------

def covered_chars(pieces: list[str], sentence: str, in_order: bool = True) -> set[int]:
    """Positions in the sentence covered by the pieces.

    Model pieces are searched in order (that's what the filter enforces).
    Gold pieces use in_order=False: each is searched from the start, so a hand-made
    gold row that lists its pieces out of order still counts in full.
    """
    covered, cursor = set(), 0
    for piece in pieces:
        start = sentence.find(piece, cursor if in_order else 0)
        if start == -1:
            continue
        covered.update(range(start, start + len(piece)))
        if in_order:
            cursor = start + len(piece)
    return covered


def warn_unordered_gold(rows: list[dict]) -> None:
    """Gold pieces should be in sentence order, like real answers. Say so if not."""
    for i, row in enumerate(rows):
        if filters.clean_core(row["core"], row["sentence"]) != row["core"]:
            print(f"  note: gold row {i} lists its pieces out of sentence order "
                  "(scored anyway; consider fixing gold_simplify.json)")


async def score_simplify(gold: list[dict], limit: int) -> None:
    rows = gold[:limit]
    print(f"Simplify score: {len(rows)} of {len(gold)} gold sentences ({len(rows)} calls)\n")
    warn_unordered_gold(rows)
    perfect = failed = 0
    latencies, precisions, recalls = [], [], []
    for row in rows:
        sentence = row["sentence"]
        start = time.perf_counter()
        try:  # only the call itself: a real failure, not a paid-for odd reply
            reply = await llm.simplify(sentence)
        except Exception as e:
            failed += 1
            print(f"  [ERR] {llm.error_kind(e)}: {sentence[:60]}...")
            if isinstance(e, json.JSONDecodeError):
                print(f"        raw reply start: {e.doc[:200]}")
            continue
        latencies.append(time.perf_counter() - start)

        # The call succeeded, so an odd shape (a bare list, null) is scored as BAD
        # with the reply shown, not counted as a failed call.
        raw = reply.get("core", []) if isinstance(reply, dict) else []
        if not isinstance(raw, list):
            raw = []
        if not raw:
            print(f"  (no core list in the reply: {json.dumps(reply, default=str)[:200]})")

        core = filters.clean_core(raw, sentence)
        ok = bool(core) and core == raw  # nothing had to be dropped
        perfect += ok
        mine, theirs = covered_chars(core, sentence), covered_chars(row["core"], sentence, in_order=False)
        both = len(mine & theirs)
        precisions.append(both / len(mine) if mine else 0.0)
        recalls.append(both / len(theirs) if theirs else 0.0)
        print(f"  [{'OK ' if ok else 'BAD'}] {core}")
        print(f"        gold {row['core']}")

    answered = len(rows) - failed
    print()
    print(f"  exact + in order  {perfect}/{answered} = {pct(perfect, answered)}")
    if answered:
        print(f"  overlap with gold precision {statistics.mean(precisions):.0%}, "
              f"recall {statistics.mean(recalls):.0%} (by characters)")
        print(f"  median latency    {statistics.median(latencies):.2f} s   (target ~2 s)")
    if failed:
        print(f"  failed calls      {failed}")


# ---------------------------------------------------------------------------

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(HERE / "test_paragraphs.txt"))
    ap.add_argument("--simplify", help="simplify one sentence instead")
    ap.add_argument("--score", action="store_true", help="compare /analyze with gold.json (1 call)")
    ap.add_argument("--score-simplify", action="store_true", help="compare /simplify with gold_simplify.json")
    ap.add_argument("--limit", type=int, default=5, help="sentences for --score-simplify (1 call each)")
    ap.add_argument("--plain", action="store_true", help="ignore '# title:' and '# heading:' lines")
    args = ap.parse_args()
    path = Path(args.file)
    title = "" if args.plain else load_title(path)
    paras = load_paragraphs(path, structure=not args.plain)

    print(f"model={llm.MODEL} mock={llm.MOCK}\n")
    if args.simplify:
        print(json.dumps(await llm.simplify(args.simplify), indent=2))
    elif args.score:
        gold = json.loads((HERE / "gold.json").read_text(encoding="utf-8"))
        await score_analyze(paras, gold, title)
    elif args.score_simplify:
        gold = json.loads((HERE / "gold_simplify.json").read_text(encoding="utf-8"))
        await score_simplify(gold, args.limit)
    else:
        await run_plain(paras, title)


if __name__ == "__main__":
    asyncio.run(main())
