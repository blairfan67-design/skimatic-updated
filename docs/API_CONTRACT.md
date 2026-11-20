# API contract (backend ⇄ extension)

This is the **one file everyone agrees on**. If you change a field name, update
this file in the same commit and tell the team. Everything else can change freely.

Base URL: `http://localhost:8000` while developing, the Render/Railway URL once deployed.

## Roles

Each highlight has exactly one role. These four strings are fixed:

| role         | meaning                                  |
|--------------|------------------------------------------|
| `main`       | the main point / claim                   |
| `evidence`   | data, examples, quotes that support it   |
| `background` | context the reader needs                 |
| `counter`    | the other side, caveats, objections      |

## `GET /health`

```json
{ "status": "ok", "mock": false }
```

`mock: true` means the server has no API key and returns fake results (useful
for frontend/extension work without spending API credits).

## `POST /analyze`

Request: the paragraphs the extension pulled out with Readability.

```json
{
  "paragraphs": [
    { "id": 0, "text": "Full text of paragraph 0..." },
    { "id": 1, "text": "Full text of paragraph 1..." }
  ]
}
```

Response: sentences to highlight. **`text` must be copied word-for-word from the
paragraph**, otherwise the extension cannot find it on the page.

```json
{
  "highlights": [
    { "paragraph_id": 0, "text": "Exact sentence from paragraph 0.", "role": "main" },
    { "paragraph_id": 1, "text": "Another exact sentence.", "role": "evidence" }
  ]
}
```

## `POST /simplify`

Request: one highlighted sentence the reader clicked.

```json
{ "sentence": "The committee, after months of debate, approved the bill on Tuesday." }
```

Response: the "backbone" (who did what to what) as exact substrings, in order.
The extension bolds these and fades everything else.

```json
{ "core": ["The committee", "approved", "the bill"] }
```

## `POST /study`

Active recall for one article: questions to think about **before** reading and a
short multiple-choice quiz to check memory **after** reading. **One Gemini call per
article**, cached, so studying the same article again is free.

Request: the same shape and limits as `/analyze` (1–200 paragraphs, at most 60,000
characters in total).

```json
{ "paragraphs": [ { "id": 0, "text": "Full text of paragraph 0..." } ] }
```

Only the first ~25,000 characters (whole paragraphs, in order) are sent to the AI, to
keep it to one call. Every `paragraph_id` in the answer is one of those paragraphs.

Response:

```json
{
  "prequestions": [
    { "question": "Why might city trees matter for summer heat?", "paragraph_id": 0 }
  ],
  "quiz": [
    {
      "question": "When was the cooling effect of trees most useful?",
      "options": ["In winter", "At night", "At noon", "Never"],
      "answer": 1,
      "explanation": "The article says tree-lined streets stayed cooler at night, when heat waves are most dangerous.",
      "paragraph_id": 2
    }
  ]
}
```

- `prequestions`: up to 3 open questions. Their answers are in the article, but the
  question doesn't give them away. `paragraph_id` is where the answer is (for a
  "show me" jump).
- `quiz`: 2–5 questions. `options` is always exactly 4 different, non-empty strings
  (≤ 120 characters); `answer` is the index (0–3) of the one right option;
  `explanation` (≤ 200 characters) says why, from the article; `paragraph_id` is where
  it is answered. The server shuffles the options (the same way every time for the same
  question), so the right answer is not always the first one.
- Questions are ≤ 200 characters, plain text (show them with `textContent`).

The server drops anything malformed (unknown `paragraph_id`, wrong number of options,
duplicate options or questions, bad `answer`, HTML tags are stripped, extra fields are
never passed on). Overlong explanations are shortened with "…".

Errors (`{"detail": "<one plain sentence>"}`), the same as `/analyze`:

| status | when |
|---|---|
| 400 | no paragraphs, or only blank ones |
| 413 | more than 200 paragraphs, more than 60,000 characters, or a body over 1 MB |
| 422 | the request isn't in the expected format |
| 429 | too many uncached `/study` requests from this IP (3 a minute, 20 an hour) |
| 503 | the AI's daily or per-minute limit is used up |
| 502 | the AI failed, or its answer had fewer than 2 usable quiz questions ("The AI didn't answer properly. Try again.") |
