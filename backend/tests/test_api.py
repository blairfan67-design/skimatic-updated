"""Run with:  pytest   (from the backend/ folder). Uses mock mode, no API key needed."""

import os

os.environ["MOCK_LLM"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

client = TestClient(main.app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_analyze_returns_exact_substrings():
    paras = [
        {"id": 0, "text": "Cats sleep a lot. They nap for hours."},
        {"id": 1, "text": "Dogs bark. Birds sing."},
    ]
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 200
    hs = r.json()["highlights"]
    assert hs, "expected at least one highlight"
    for h in hs:
        assert h["role"] in {"main", "evidence", "background", "counter"}
        assert h["text"] in paras[h["paragraph_id"]]["text"]


def test_analyze_drops_hallucinated_text(monkeypatch):
    async def fake(_, **kw):
        return {"highlights": [
            {"paragraph_id": 0, "text": "Not in the paragraph.", "role": "main"},
            {"paragraph_id": 0, "text": "Cats sleep a lot.", "role": "nonsense"},
            {"paragraph_id": 0, "text": "Cats sleep a lot.", "role": "main"},
        ]}
    monkeypatch.setattr(main.llm, "analyze", fake)
    r = client.post("/analyze", json={"paragraphs": [{"id": 0, "text": "Cats sleep a lot."}]})
    assert r.json()["highlights"] == [{"paragraph_id": 0, "text": "Cats sleep a lot.", "role": "main"}]


def test_simplify():
    s = "The committee, after months of debate, approved the bill on Tuesday."
    r = client.post("/simplify", json={"sentence": s})
    assert r.status_code == 200
    assert all(c in s for c in r.json()["core"])
