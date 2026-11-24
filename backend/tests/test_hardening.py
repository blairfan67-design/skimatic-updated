"""Tests for cache, retry, chunking, limits, filters and error messages. No API key needed."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from google.genai import errors

import filters
import llm
import main
from main import Paragraph

client = TestClient(main.app)


def gemini_error(code, status, message):
    """A real google-genai exception, like the ones Gemini raises."""
    cls = errors.ServerError if code >= 500 else errors.ClientError
    return cls(code, {"error": {"code": code, "status": status, "message": message}})


class Counter:
    """A fake llm.analyze / llm.simplify that counts how often it is called."""

    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    async def __call__(self, arg, **kw):
        self.calls.append(arg)
        return self.answer(arg) if callable(self.answer) else self.answer


PARAS = [{"id": 0, "text": "Cats sleep a lot. They nap for hours."}]


# --- cache -----------------------------------------------------------------

def test_analyze_cache_hit_makes_no_second_call(monkeypatch):
    fake = Counter({"highlights": [{"paragraph_id": 0, "text": "Cats sleep a lot.", "role": "main"}]})
    monkeypatch.setattr(main.llm, "analyze", fake)
    first = client.post("/analyze", json={"paragraphs": PARAS}).json()
    # Same article with different whitespace: still a cache hit.
    again = [{"id": 0, "text": "Cats sleep a lot.  They nap for hours.\n"}]
    second = client.post("/analyze", json={"paragraphs": again}).json()
    assert len(fake.calls) == 1
    assert first == second == {"highlights": [{"paragraph_id": 0, "text": "Cats sleep a lot.", "role": "main"}]}


def test_simplify_cache_hit_makes_no_second_call(monkeypatch):
    fake = Counter({"core": ["The cat", "sat"]})
    monkeypatch.setattr(main.llm, "simplify", fake)
    for _ in range(3):
        r = client.post("/simplify", json={"sentence": "The cat quietly sat."})
        assert r.json() == {"core": ["The cat", "sat"]}
    assert len(fake.calls) == 1


def test_failures_are_not_cached(monkeypatch):
    async def boom(_, **kw):
        raise RuntimeError("down")
    monkeypatch.setattr(main.llm, "analyze", boom)
    assert client.post("/analyze", json={"paragraphs": PARAS}).status_code == 502
    fake = Counter({"highlights": []})
    monkeypatch.setattr(main.llm, "analyze", fake)
    assert client.post("/analyze", json={"paragraphs": PARAS}).status_code == 200
    assert len(fake.calls) == 1


@pytest.mark.parametrize("bad_answer", [
    [], None, {"highlights": "x"}, {"highlights": []},
    {"highlights": [{"paragraph_id": 0, "text": "Cats are sleepy animals.", "role": "main"}]},  # paraphrase
])
def test_empty_analyze_answer_is_not_cached(monkeypatch, bad_answer):
    monkeypatch.setattr(main.llm, "analyze", Counter(bad_answer))
    assert client.post("/analyze", json={"paragraphs": PARAS}).json() == {"highlights": []}
    good = Counter({"highlights": [{"paragraph_id": 0, "text": "Cats sleep a lot.", "role": "main"}]})
    monkeypatch.setattr(main.llm, "analyze", good)
    assert len(client.post("/analyze", json={"paragraphs": PARAS}).json()["highlights"]) == 1
    assert len(good.calls) == 1  # asked again instead of serving the empty answer


def test_cache_hit_with_other_spacing_keeps_every_highlight(monkeypatch):
    paras = [{"id": 0, "text": "Prices  rose\nsharply. Then fell."}, {"id": 1, "text": "The vote passed."}]
    fake = Counter({"highlights": [
        {"paragraph_id": 0, "text": "Prices  rose\nsharply.", "role": "main"},
        {"paragraph_id": 1, "text": "The vote passed.", "role": "evidence"},
    ]})
    monkeypatch.setattr(main.llm, "analyze", fake)
    client.post("/analyze", json={"paragraphs": paras})
    respaced = [{"id": 0, "text": "Prices rose sharply. Then fell."}, {"id": 1, "text": "The  vote passed."}]
    hs = client.post("/analyze", json={"paragraphs": respaced}).json()["highlights"]
    assert len(fake.calls) == 1
    # Same highlights, spelled the way *this* page spells them.
    assert [h["text"] for h in hs] == ["Prices rose sharply.", "The  vote passed."]


def test_simplify_cache_hit_with_other_spacing(monkeypatch):
    fake = Counter({"core": ["The committee", "approved the bill"]})
    monkeypatch.setattr(main.llm, "simplify", fake)
    client.post("/simplify", json={"sentence": "The committee approved the bill."})
    r = client.post("/simplify", json={"sentence": "The committee approved  the bill."})
    assert r.json() == {"core": ["The committee", "approved  the bill"]}
    assert len(fake.calls) == 1


def test_identical_requests_at_the_same_time_make_one_call(monkeypatch):
    import httpx

    calls = []

    async def slow(chunk, **kw):
        calls.append(chunk)
        await asyncio.sleep(0.05)  # still running when the second request arrives
        return {"highlights": [{"paragraph_id": 0, "text": "Cats sleep a lot.", "role": "main"}]}

    async def slow_simplify(sentence):
        calls.append(sentence)
        await asyncio.sleep(0.05)
        return {"core": ["The cat", "sat"]}

    monkeypatch.setattr(main.llm, "analyze", slow)
    monkeypatch.setattr(main.llm, "simplify", slow_simplify)

    async def twice(path, body):
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            return await asyncio.gather(c.post(path, json=body), c.post(path, json=body))

    a, b = asyncio.run(twice("/analyze", {"paragraphs": PARAS}))
    assert a.json() == b.json() and len(a.json()["highlights"]) == 1
    a, b = asyncio.run(twice("/simplify", {"sentence": "The cat quietly sat."}))
    assert a.json() == b.json() == {"core": ["The cat", "sat"]}
    assert len(calls) == 2  # one per endpoint, not two


def test_lru_cache_forgets_oldest():
    c = main.cache.LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.get("a")  # a is now the most recent
    c.put("c", 3)
    assert c.get("b") is None and c.get("a") == 1 and c.get("c") == 3


# --- retry -----------------------------------------------------------------

def run_ask_json(monkeypatch, outcomes):
    """Call llm.ask_json with _generate replaced by a script of results/exceptions."""
    calls = []

    async def fake_generate(prompt):
        outcome = outcomes[len(calls)]
        calls.append(prompt)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(llm, "_generate", fake_generate)
    return asyncio.run(llm.ask_json("hi")), calls


@pytest.mark.parametrize("first_error", [
    gemini_error(503, "UNAVAILABLE", "overloaded"),
    asyncio.TimeoutError(),
])
def test_retry_once_on_transient_error(monkeypatch, first_error):
    result, calls = run_ask_json(monkeypatch, [first_error, '{"ok": true}'])
    assert result == {"ok": True}
    assert len(calls) == 2


DAILY_429 = gemini_error(429, "RESOURCE_EXHAUSTED",
                         "Quota exceeded. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier")
MINUTE_429 = gemini_error(429, "RESOURCE_EXHAUSTED",
                          "Quota exceeded. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier")


@pytest.mark.parametrize("error", [
    gemini_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."),
    gemini_error(404, "NOT_FOUND", "models/nope is not found"),
    DAILY_429,  # the daily quota can't come back within a second
    MINUTE_429,  # Gemini asks for ~40 s; a quick retry would just fail again
])
def test_no_retry_on_permanent_error(monkeypatch, error):
    with pytest.raises(errors.ClientError):
        run_ask_json(monkeypatch, [error, '{"ok": true}'])


def test_429_kinds_are_told_apart():
    assert llm.error_kind(DAILY_429) == "quota"
    assert llm.error_kind(MINUTE_429) == "rate_limit"


def test_only_one_retry(monkeypatch):
    err = gemini_error(503, "UNAVAILABLE", "overloaded")
    with pytest.raises(errors.ServerError):
        run_ask_json(monkeypatch, [err, err, '{"ok": true}'])


# --- chunking --------------------------------------------------------------

def paras_of(n, text="Hi."):
    return [Paragraph(id=i, text=text) for i in range(n)]


def test_extension_sized_article_is_one_call():
    # The extension sends at most 80 paragraphs; short ones must not cost extra calls.
    assert len(main.split_into_chunks(paras_of(80, "x" * 90))) == 1


def test_long_article_chunks_are_even():
    assert [len(c) for c in main.split_into_chunks(paras_of(90))] == [45, 45]
    assert [len(c) for c in main.split_into_chunks(paras_of(200))] == [67, 67, 66]
    # Splits on size too: 30 paragraphs of 1,000 characters -> 2 calls of ~15,000.
    assert [len(c) for c in main.split_into_chunks(paras_of(30, "x" * 1000))] == [15, 15]


def test_biggest_article_is_at_most_three_calls():
    paras = paras_of(200, "x" * 299)  # 59,800 characters, just under the limit
    assert len(main.split_into_chunks(paras)) == 3


def mixed(*groups):
    """Paragraphs from (count, length) groups, e.g. mixed((20, 2900), (20, 10))."""
    texts = [("x" * length) for count, length in groups for _ in range(count)]
    return [Paragraph(id=i, text=t) for i, t in enumerate(texts)]


@pytest.mark.parametrize("paras, calls", [
    (mixed((20, 2900), (20, 10)), 3),     # long paragraphs first, then short ones
    (mixed((14, 1500), (16, 10)), 2),
    # Short first: equal counts gave one 35k chunk. 4 calls, because the
    # 80-paragraph cap stops the first chunk from taking all the short ones.
    (mixed((100, 60), (100, 530)), 4),
    (mixed((40, 10), (40, 900)), 2),      # inside the extension's 80-paragraph limit
])
def test_uneven_paragraphs_never_make_a_huge_chunk(paras, calls):
    chunks = main.split_into_chunks(paras)
    assert len(chunks) == calls
    assert max(sum(len(p.text) for p in c) for c in chunks) <= main.CHUNK_MAX_CHARS
    assert [p.id for c in chunks for p in c] == [p.id for p in paras]  # nothing lost or reordered


def test_one_giant_paragraph_gets_its_own_chunk():
    paras = mixed((1, 100), (1, 30_000), (1, 100))
    assert [len(c) for c in main.split_into_chunks(paras)] == [1, 1, 1]


@pytest.fixture
def small_chunks(monkeypatch):
    """Split after 20 paragraphs, so tests can use short articles."""
    monkeypatch.setattr(main, "CHUNK_MAX_PARAGRAPHS", 20)


def test_chunked_analyze_keeps_original_ids(monkeypatch, small_chunks):
    # Ids start at 100 and skip numbers, like a real page might.
    paras = [{"id": 100 + 2 * i, "text": f"Sentence {i} here. Filler."} for i in range(60)]

    def answer(chunk):  # highlight the first sentence of every paragraph in the chunk
        return {"highlights": [{"paragraph_id": p.id, "text": p.text.split(". ")[0] + ".", "role": "evidence"}
                               for p in chunk]}

    fake = Counter(answer)
    monkeypatch.setattr(main.llm, "analyze", fake)
    hs = client.post("/analyze", json={"paragraphs": paras}).json()["highlights"]
    assert len(fake.calls) == 3  # 60 paragraphs -> 3 chunks of 20, not 60 calls
    assert [h["paragraph_id"] for h in hs] == [p["id"] for p in paras]
    assert all(h["text"] in paras[i]["text"] for i, h in enumerate(hs))


def test_chunk_cannot_claim_paragraph_of_another_chunk(monkeypatch, small_chunks):
    paras = [{"id": i, "text": f"Para {i}."} for i in range(40)]
    # Every chunk wrongly says paragraph 0; only the chunk that contains 0 may keep it.
    fake = Counter({"highlights": [{"paragraph_id": 0, "text": "Para 0.", "role": "main"}]})
    monkeypatch.setattr(main.llm, "analyze", fake)
    hs = client.post("/analyze", json={"paragraphs": paras}).json()["highlights"]
    assert len(fake.calls) == 2
    assert hs == [{"paragraph_id": 0, "text": "Para 0.", "role": "main"}]


def test_failed_chunk_is_the_only_one_paid_again(monkeypatch, small_chunks):
    paras = [{"id": i, "text": f"Para {i}."} for i in range(40)]
    fail_first_chunk = [True]

    def answer(chunk):
        if chunk[0].id == 0 and fail_first_chunk[0]:
            raise RuntimeError("chunk failed")
        return {"highlights": [{"paragraph_id": chunk[0].id, "text": chunk[0].text, "role": "main"}]}

    async def flaky(chunk, **kw):
        calls.append(chunk[0].id)
        return answer(chunk)

    calls = []
    monkeypatch.setattr(main.llm, "analyze", flaky)
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 200  # partial answer, not an error
    assert [h["paragraph_id"] for h in r.json()["highlights"]] == [20]

    fail_first_chunk[0] = False
    r = client.post("/analyze", json={"paragraphs": paras})
    assert [h["paragraph_id"] for h in r.json()["highlights"]] == [0, 20]
    assert sorted(calls) == [0, 0, 20]  # the good chunk was not paid for twice


def test_one_429_stops_the_other_chunks(monkeypatch, small_chunks):
    paras = [{"id": i, "text": f"Para {i}."} for i in range(60)]
    calls = []

    async def exhausted(chunk, **kw):
        calls.append(chunk)
        raise DAILY_429

    monkeypatch.setattr(main.llm, "analyze", exhausted)
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 503 and "daily limit" in r.json()["detail"]
    assert len(calls) == 2  # the two parallel calls; the third chunk never went out


def test_all_chunks_failing_reports_the_daily_limit(monkeypatch, small_chunks):
    # The first chunk fails for an ordinary reason, the others hit the quota:
    # the reader must hear "daily limit", not "try again".
    paras = [{"id": i, "text": f"Para {i}."} for i in range(60)]

    async def fail(chunk, **kw):
        if chunk[0].id == 0:
            raise ValueError("bad json")
        raise DAILY_429

    monkeypatch.setattr(main.llm, "analyze", fail)
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 503 and "daily limit" in r.json()["detail"]


def test_mock_mode_long_article_works(small_chunks):
    paras = [{"id": i, "text": f"Point number {i}. More words."} for i in range(45)]
    hs = client.post("/analyze", json={"paragraphs": paras}).json()["highlights"]
    # Mock gives every paragraph one highlight; only "main" is capped at 3.
    mains = [h for h in hs if h["role"] == "main"]
    assert len(mains) == 3
    assert len(hs) > 30 and len({h["paragraph_id"] for h in hs}) == len(hs)


# --- limits ----------------------------------------------------------------

def test_empty_paragraph_list_is_400():
    r = client.post("/analyze", json={"paragraphs": []})
    assert r.status_code == 400
    assert "No paragraphs" in r.json()["detail"]


def test_all_blank_paragraphs_are_400_without_a_call(monkeypatch):
    fake = Counter({"highlights": []})
    monkeypatch.setattr(main.llm, "analyze", fake)
    r = client.post("/analyze", json={"paragraphs": [{"id": 0, "text": "  "}, {"id": 1, "text": ""}]})
    assert r.status_code == 400 and fake.calls == []


def test_blank_paragraphs_are_not_sent(monkeypatch):
    fake = Counter({"highlights": []})
    monkeypatch.setattr(main.llm, "analyze", fake)
    client.post("/analyze", json={"paragraphs": [{"id": 0, "text": " "}, *PARAS]})
    assert [p.id for p in fake.calls[0]] == [0] and fake.calls[0][0].text == PARAS[0]["text"]


def test_huge_article_is_413():
    paras = [{"id": i, "text": "x" * 10_000} for i in range(7)]  # 70,000 characters
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 413
    assert "too long" in r.json()["detail"]


def test_more_than_200_paragraphs_rejected():
    paras = [{"id": i, "text": "Hi."} for i in range(201)]
    assert client.post("/analyze", json={"paragraphs": paras}).status_code == 413


# --- filters ---------------------------------------------------------------

def P(text, id=0):
    return Paragraph(id=id, text=text)


def test_filter_drops_empty_and_duplicates():
    para = P("A one. B two. C three.")
    raw = [
        {"paragraph_id": 0, "text": "  ", "role": "main"},
        {"paragraph_id": 0, "text": "A one.", "role": "main"},
        {"paragraph_id": 0, "text": "A one.", "role": "evidence"},
    ]
    assert filters.clean_highlights(raw, [para]) == [{"paragraph_id": 0, "text": "A one.", "role": "main"}]


def test_filter_caps_two_per_paragraph_and_sorts():
    para = P("A one. B two. C three.")
    raw = [{"paragraph_id": 0, "text": t, "role": "evidence"} for t in ["C three.", "A one.", "B two."]]
    kept = filters.clean_highlights(raw, [para])
    assert [h["text"] for h in kept] == ["A one.", "C three."]  # model's first two, in page order


def test_filter_drops_overlap():
    para = P("Prices rose sharply in May. Then they fell.")
    raw = [
        {"paragraph_id": 0, "text": "Prices rose sharply in May.", "role": "main"},
        {"paragraph_id": 0, "text": "rose sharply", "role": "evidence"},
    ]
    assert [h["text"] for h in filters.clean_highlights(raw, [para])] == ["Prices rose sharply in May."]


def test_filter_rejects_bad_shapes():
    raw = [None, "text", {"paragraph_id": "zero", "text": "A one.", "role": "main"},
           {"paragraph_id": 0.5, "text": "A one.", "role": "main"},
           {"paragraph_id": 9, "text": "A one.", "role": "main"}]
    assert filters.clean_highlights(raw, [P("A one.")]) == []
    assert filters.clean_highlights({"not": "a list"}, [P("A one.")]) == []


def test_filter_skips_unhashable_or_bool_ids():
    raw = [{"paragraph_id": [0], "text": "A one.", "role": "main"},
           {"paragraph_id": True, "text": "A one.", "role": "main"},
           {"paragraph_id": 0, "text": "A one.", "role": "evidence"}]
    assert filters.clean_highlights(raw, [P("A one.")]) == [{"paragraph_id": 0, "text": "A one.", "role": "evidence"}]


def test_filter_accepts_quoted_or_float_ids():
    # The old pydantic check turned "0" and 0.0 into 0; a model that quotes ids
    # must not silently lose every highlight.
    paras = [P("A one."), Paragraph(id=1, text="B two.")]
    raw = [{"paragraph_id": "0", "text": "A one.", "role": "main"},
           {"paragraph_id": 1.0, "text": "B two.", "role": "evidence"}]
    assert filters.clean_highlights(raw, paras) == [
        {"paragraph_id": 0, "text": "A one.", "role": "main"},
        {"paragraph_id": 1, "text": "B two.", "role": "evidence"},
    ]


def test_bad_id_in_one_chunk_keeps_the_others(monkeypatch, small_chunks):
    paras = [{"id": i, "text": f"Para {i}."} for i in range(40)]

    async def answer(chunk, **kw):
        pid = [chunk[0].id] if chunk[0].id == 0 else chunk[0].id
        return {"highlights": [{"paragraph_id": pid, "text": chunk[0].text, "role": "main"}]}

    monkeypatch.setattr(main.llm, "analyze", answer)
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 200 and [h["paragraph_id"] for h in r.json()["highlights"]] == [20]


def test_simplify_keeps_order_and_drops_overlap():
    s = "The committee, after months of debate, approved the bill."
    raw = ["The committee", "", "approved", "The committee", "committee", "the bill", "debate"]
    # "The committee" again and "debate" come before the cursor -> dropped.
    assert filters.clean_core(raw, s) == ["The committee", "approved", "the bill"]


def test_simplify_endpoint_filters(monkeypatch):
    monkeypatch.setattr(main.llm, "simplify", Counter({"core": ["the bill", "The committee", "nope"]}))
    r = client.post("/simplify", json={"sentence": "The committee approved the bill."})
    assert r.json() == {"core": ["the bill"]}


# --- error messages --------------------------------------------------------

@pytest.mark.parametrize("error, status, words", [
    (DAILY_429, 503, "daily limit"),
    (MINUTE_429, 503, "Wait a minute"),
    (gemini_error(400, "INVALID_ARGUMENT", "API key not valid."), 502, "isn't available right now"),
    (gemini_error(404, "NOT_FOUND", "models/gemini-x is not found"), 502, "isn't available right now"),
    (ValueError("Expecting value: line 1 column 1"), 502, "didn't answer properly"),
])
def test_errors_become_human_messages(monkeypatch, error, status, words):
    async def boom(_, **kw):
        raise error
    monkeypatch.setattr(main.llm, "analyze", boom)
    monkeypatch.setattr(main.llm, "simplify", boom)
    for path, body in [("/analyze", {"paragraphs": PARAS}), ("/simplify", {"sentence": "Hi there."})]:
        r = client.post(path, json=body)
        assert r.status_code == status
        detail = r.json()["detail"]
        assert words in detail
        assert "Expecting" not in detail and "models/" not in detail  # no internals leak


def test_health_has_model():
    body = client.get("/health").json()
    assert body == {"status": "ok", "mock": True}


# --- prompt_lab scoring runs in mock mode ------------------------------------

def test_prompt_lab_scores_run(capsys):
    import json

    import prompt_lab
    paras = prompt_lab.load_paragraphs(prompt_lab.HERE / "test_paragraphs.txt")
    gold = json.loads((prompt_lab.HERE / "gold.json").read_text())
    asyncio.run(prompt_lab.score_analyze(paras, gold))
    gold_s = json.loads((prompt_lab.HERE / "gold_simplify.json").read_text())
    asyncio.run(prompt_lab.score_simplify(gold_s, 2))
    out = capsys.readouterr().out
    assert "precision vs gold" in out and "median latency" in out


@pytest.mark.parametrize("reply", [
    {"highlights": [{"paragraph_id": [0], "text": "x", "role": "main"}]},  # list id
    [{"paragraph_id": 0, "text": "x", "role": "main"}],                     # list, not dict
    {"highlights": [{"paragraph_id": 0, "text": "x", "role": None}]},       # null role
    {"highlights": "none"},
])
def test_prompt_lab_survives_odd_replies(monkeypatch, capsys, reply):
    # The Gemini call is already spent by then: print a score, don't crash.
    import json

    import prompt_lab

    async def fake(paras, **kw):
        return reply

    monkeypatch.setattr(prompt_lab.llm, "analyze", fake)
    paras = prompt_lab.load_paragraphs(prompt_lab.HERE / "test_paragraphs.txt")
    gold = json.loads((prompt_lab.HERE / "gold.json").read_text())
    asyncio.run(prompt_lab.score_analyze(paras, gold))
    asyncio.run(prompt_lab.run_plain(paras))
    assert "precision vs gold" in capsys.readouterr().out


@pytest.mark.parametrize("pid", ["²", "¹", "٣", "1²"])
def test_unicode_digit_id_is_not_an_id(pid):
    # str.isdigit() is True for these but int() rejects them: must not crash.
    import filters
    assert filters.as_paragraph_id(pid) is None


def test_unicode_digit_id_keeps_other_highlights(monkeypatch):
    # One odd id must not throw away the valid highlights of the same reply.
    async def fake(paras, **kw):
        return {"highlights": [
            {"paragraph_id": "²", "text": PARAS[0]["text"], "role": "main"},
            {"paragraph_id": PARAS[0]["id"], "text": PARAS[0]["text"], "role": "main"},
        ]}
    monkeypatch.setattr(main.llm, "analyze", fake)
    r = client.post("/analyze", json={"paragraphs": PARAS})
    assert r.status_code == 200
    assert len(r.json()["highlights"]) == 1


def test_prompt_lab_score_survives_cut_off_json(monkeypatch, capsys):
    # A reply cut off by the length limit is invalid JSON: report it, show it.
    import json

    import prompt_lab

    async def cut_off(prompt, schema=None):
        return '{"highlights": [{"paragraph_id": 0, "text": "cut off'

    monkeypatch.setattr(llm, "MOCK", False)
    monkeypatch.setattr(llm, "_generate", cut_off)
    paras = prompt_lab.load_paragraphs(prompt_lab.HERE / "test_paragraphs.txt")
    gold = json.loads((prompt_lab.HERE / "gold.json").read_text())
    asyncio.run(prompt_lab.score_analyze(paras, gold))
    asyncio.run(prompt_lab.run_plain(paras))
    out = capsys.readouterr().out
    assert "call failed" in out and '"text": "cut off' in out


@pytest.mark.parametrize("reply", [["The"], None, {"core": "The"}])
def test_prompt_lab_simplify_odd_reply_is_bad_not_failed(monkeypatch, capsys, reply):
    import json

    import prompt_lab

    async def odd(sentence):
        return reply

    monkeypatch.setattr(prompt_lab.llm, "simplify", odd)
    gold_s = json.loads((prompt_lab.HERE / "gold_simplify.json").read_text())
    asyncio.run(prompt_lab.score_simplify(gold_s, 1))
    out = capsys.readouterr().out
    assert "[BAD]" in out and "0/1" in out and "failed calls" not in out


# --- added during integration review -------------------------------------------

def test_too_many_paragraphs_is_413_with_readable_message():
    paras = [{"id": i, "text": f"Paragraph number {i} has some words."} for i in range(201)]
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 413
    assert "too many paragraphs" in r.json()["detail"]


def test_main_points_capped_at_three_in_article_order():
    hs = [{"paragraph_id": i, "text": f"S{i}.", "role": "main"} for i in range(5)]
    hs.insert(2, {"paragraph_id": 9, "text": "E.", "role": "evidence"})
    kept = main.cap_main(hs)
    assert [h["role"] for h in kept].count("main") == 3
    assert [h["paragraph_id"] for h in kept if h["role"] == "main"] == [0, 1, 2]
    assert any(h["role"] == "evidence" for h in kept)
