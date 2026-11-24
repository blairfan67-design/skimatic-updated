# Skimatic: notes for Claude

## Where the code lives
- The main repo is **blairfan67-design/skimatic-updated** (branch `main`). All new work goes there.
- `Sohah07/Skimatic` is the old team repo, for reference only. Don't develop there.

## Every change must show up as commits on GitHub
The owner wants to see every change as its own commit after pushing. So:
- Make **one commit per logical change** (a feature, a fix, a doc update), with a clear message saying what changed and why. Never squash several changes into one commit, and never rewrite history that has already been pushed.
- If this session can push to `skimatic-updated`: push a branch, open a pull request, and only merge when the owner says so.
- If it can't push: deliver a **patch series** made with `git format-patch --stdout <their main>..HEAD`. Applying it with `git am` recreates **every commit** with its message, and a single `git push` then shows them all. Before sending, apply the patch to a fresh clone of `skimatic-updated` to check it applies cleanly and contains every commit. Give the exact commands:
  `cd ~/skimatic && git checkout main && git pull && git am ~/Downloads/<file>.patch && git push`
- After the owner pushes, check the commits are on GitHub (`git ls-remote` / `git log origin/main`) and say which ones arrived.

## Before every commit
- Backend tests pass: `cd backend && .venv/bin/python -m pytest -q`.
- `node --check` passes on every changed extension file.
- For extension or backend changes, the security suite passes: start the backend with `MOCK_LLM=1`, then run `NODE_PATH=$(npm root -g) node testing/security/run.js`.
- Keep the security rules in `docs/` and `backend/HANDOFF.md`: no secrets in git, render AI and article text with `textContent`, no inline styles (CSP), least-privilege manifest, validated AI output, rate limits, and no article text in logs.

## The team
- They're students. Explain steps plainly, and give copy-paste terminal commands for macOS.
- The Gemini free tier allows about 20 calls a day, so keep AI calls to a minimum.
