"""Security gate item 2: malformed and oversized requests (see SECURITY_GATE)."""

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)
FORMAT_MSG = "The request wasn't in the expected format."


def test_malformed_bodies_get_one_plain_sentence():
    for body in ({}, {"paragraphs": "not a list"}, {"paragraphs": [{"id": "x", "text": 123}]}):
        r = client.post("/analyze", json=body)
        assert r.status_code == 422
        assert r.json() == {"detail": FORMAT_MSG}


def test_invalid_json_gets_the_same_sentence():
    r = client.post("/analyze", content=b"garbage{", headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and r.json() == {"detail": FORMAT_MSG}


def test_422_never_echoes_the_input():
    long_sentence = "word " * 5000  # 25,000 characters, over the 2,000 limit
    r = client.post("/simplify", json={"sentence": long_sentence})
    assert r.status_code == 422
    assert "word word" not in r.text and len(r.content) < 200


def test_body_over_1mb_is_413_before_parsing():
    big = b'{"paragraphs":[{"id":0,"text":"' + b"a" * 1_200_000 + b'"}]}'
    r = client.post("/analyze", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": "This request is too large."}


def test_chunked_body_over_1mb_is_413():
    def chunks():  # no Content-Length header: sent in pieces
        yield b'{"paragraphs":[{"id":0,"text":"'
        for _ in range(12):
            yield b"a" * 100_000
        yield b'"}]}'
    r = client.post("/analyze", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_normal_requests_still_work_under_the_cap():
    paras = [{"id": i, "text": f"Sentence number {i} is here. Another one follows."} for i in range(5)]
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 200 and r.json()["highlights"]


# --- Security gate item 4 ---------------------------------------------------

def test_config_errors_do_not_name_settings_or_paths(monkeypatch, caplog):
    from google.genai import errors

    async def bad_key(_, **kw):
        raise errors.ClientError(400, {"error": {"code": 400, "message": "API key not valid.",
                                                 "status": "INVALID_ARGUMENT"}})
    monkeypatch.setattr(main.llm, "analyze", bad_key)
    r = client.post("/analyze", json={"paragraphs": [{"id": 0, "text": "A sentence long enough to send."}]})
    assert r.status_code == 502
    for leak in ("GEMINI", ".env", "backend/", "INVALID_ARGUMENT"):
        assert leak not in r.text
    assert "GEMINI_API_KEY" in caplog.text  # the team still sees the hint in the log


def test_api_docs_are_off_by_default():
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_health_shows_no_config():
    assert client.get("/health").json() == {"status": "ok", "mock": True}


# --- Security gate item 5: CORS -------------------------------------------

EXT = "chrome-extension://" + "a" * 32


def preflight(origin):
    return client.options("/analyze", headers={
        "Origin": origin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"})


def test_websites_are_not_allowed_by_cors():
    r = preflight("https://evil.example")
    assert "access-control-allow-origin" not in r.headers


def test_chrome_extensions_are_allowed_by_cors():
    r = preflight(EXT)
    assert r.headers.get("access-control-allow-origin") == EXT


def test_only_get_and_post_are_allowed():
    allowed = preflight(EXT).headers.get("access-control-allow-methods", "")
    assert "DELETE" not in allowed and "POST" in allowed


# --- Security gate item 6: rate limiting -------------------------------------

import pytest  # noqa: E402

import ratelimit  # noqa: E402


@pytest.fixture
def limits_on(monkeypatch):
    monkeypatch.setattr(ratelimit, "ENABLED", True)


def article(i):
    return {"paragraphs": [{"id": 0, "text": f"Different article number {i} with enough words."}]}


def test_analyze_burst_is_stopped_before_gemini(limits_on, monkeypatch):
    calls = []
    real = main.llm.analyze

    async def counting(paragraphs, **kw):
        calls.append(1)
        return await real(paragraphs, **kw)
    monkeypatch.setattr(main.llm, "analyze", counting)
    codes = [client.post("/analyze", json=article(i)).status_code for i in range(10)]
    assert codes[:5] == [200] * 5 and set(codes[5:]) == {429}
    assert len(calls) == 5  # the blocked ones never reached Gemini
    r = client.post("/analyze", json=article(99))
    assert r.json()["detail"] == ratelimit.TOO_FAST and r.headers["retry-after"] == "60"


def test_cached_article_does_not_count(limits_on):
    for _ in range(10):  # the same article again and again: only the first is a Gemini call
        assert client.post("/analyze", json=article(1)).status_code == 200


def test_simplify_burst_is_limited(limits_on):
    codes = [client.post("/simplify", json={"sentence": f"Sentence {i} is here."}).status_code
             for i in range(25)]
    assert codes[:20] == [200] * 20 and set(codes[20:]) == {429}


def test_minute_window_resets_but_hour_window_holds(limits_on):
    class Req:  # a stand-in request from one IP
        headers = {}
        client = type("C", (), {"host": "1.2.3.4"})()
    t = 1000.0
    for minute in range(6):  # 5 per minute for 6 minutes = 30, the hourly cap
        for _ in range(5):
            ratelimit.check("analyze", Req, now=t + minute * 61)
    with pytest.raises(Exception):
        ratelimit.check("analyze", Req, now=t + 6 * 61)  # minute is fresh, hour is full


def test_ip_comes_from_last_forwarded_entry_only_behind_proxy(monkeypatch):
    class Req:
        headers = {"x-forwarded-for": "6.6.6.6, 203.0.113.9"}  # first one is attacker-supplied
        client = type("C", (), {"host": "10.0.0.1"})()
    assert ratelimit.client_ip(Req) == "10.0.0.1"  # not trusted by default
    monkeypatch.setattr(ratelimit, "TRUST_PROXY", True)
    assert ratelimit.client_ip(Req) == "203.0.113.9"


def test_daily_budget_returns_daily_limit_message(monkeypatch):
    monkeypatch.setattr(ratelimit, "DAILY_AI_BUDGET", 2)
    codes = [client.post("/analyze", json=article(i)).status_code for i in range(3)]
    assert codes == [200, 200, 503]
    assert "daily limit" in client.post("/analyze", json=article(7)).json()["detail"]


# --- Security gate item 7: no article text kept or logged ----------------------

import logging  # noqa: E402

MARK = "Zebra-Quokka private diary sentence"


def all_cached_values():
    return list(main.ANALYZE_CACHE._data.values()) + list(main.SIMPLIFY_CACHE._data.values())


def test_cache_holds_positions_not_text():
    client.post("/analyze", json={"paragraphs": [{"id": 0, "text": MARK + " one. Second part."}]})
    client.post("/simplify", json={"sentence": MARK + " goes here."})
    assert all_cached_values(), "something should be cached"
    assert "Zebra" not in repr(all_cached_values())


def test_cache_hit_rebuilds_the_same_answer_even_with_different_spacing(monkeypatch):
    para = "Prices rose sharply in May. Analysts were surprised by the jump."
    first = client.post("/analyze", json={"paragraphs": [{"id": 0, "text": para}]}).json()

    async def must_not_call(_, **kw):
        raise AssertionError("should have been a cache hit")
    monkeypatch.setattr(main.llm, "analyze", must_not_call)
    spaced = para.replace(" sharply", "  sharply")  # same article, different whitespace
    again = client.post("/analyze", json={"paragraphs": [{"id": 0, "text": spaced}]}).json()
    assert [h["role"] for h in again["highlights"]] == [h["role"] for h in first["highlights"]]
    for h in again["highlights"]:
        assert h["text"] in spaced  # exact characters of THIS request


def test_simplify_cache_hit_rebuilds_pieces(monkeypatch):
    s = "The committee approved the bill on Tuesday."
    first = client.post("/simplify", json={"sentence": s}).json()

    async def must_not_call(_):
        raise AssertionError("should have been a cache hit")
    monkeypatch.setattr(main.llm, "simplify", must_not_call)
    assert client.post("/simplify", json={"sentence": s}).json() == first


def test_error_messages_never_reach_the_log(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)

    async def boom(_, **kw):
        raise RuntimeError("upstream said: " + MARK)
    monkeypatch.setattr(main.llm, "analyze", boom)
    monkeypatch.setattr(main.llm, "simplify", boom)
    client.post("/analyze", json={"paragraphs": [{"id": 0, "text": MARK + " here."}]})
    client.post("/simplify", json={"sentence": MARK + " here."})
    assert "Zebra" not in caplog.text
    assert "RuntimeError" in caplog.text  # the team still sees what kind of error it was
