# Test plan (integration & testing)

## A. Readability on real sites
Open each page, click **Highlight this article**, and check the console
(right-click page → Inspect → Console, look for `[SCR] extracted`).

| Site / URL | Type | Paragraphs found | Missed text / junk included? | Highlights found x/y | Layout broken? |
|------------|------|------------------|------------------------------|----------------------|----------------|
|            | news |                  |                              |                      |                |
|            | opinion |               |                              |                      |                |
|            | science |               |                              |                      |                |
|            | blog (Medium/Substack) |  |                              |                      |                |
|            | Wikipedia |             |                              |                      |                |

"Highlights found x/y" comes from the side panel status line. If x is much lower
than y, the text on the page differs from what Readability extracted (curly quotes,
hidden text, footnote markers…) — note which sentences failed.

## B. Feature checklist (run before the demo)
- [ ] Backend pill says `backend: ok` (not offline / mock) with the deployed URL
- [ ] Highlights appear in the 4 role colors
- [ ] Changing a color in the side panel updates the page instantly
- [ ] Colors are still your custom ones after opening a different article
- [ ] "Show highlights" toggle hides and shows them
- [ ] Clicking a highlight bolds the core and fades the rest; clicking again restores it
- [ ] Links inside highlighted sentences still work
- [ ] Running "Highlight" twice doesn't double-highlight
- [ ] Works on a tab that was open before the extension was reloaded
- [ ] Dark-mode site: highlights still readable
- [ ] On a tab Skimatic wasn't used on, the panel says it can't read it; clicking the toolbar
      icon (or Alt+Shift+H) on that tab fixes it
- [ ] "Use on every website" asks Chrome for permission; turning it off removes it
- [ ] Study: "Get questions" shows 3 questions; "Show where" → "Where?" scrolls to the paragraph
- [ ] Study: "Quiz me" → 5 questions, Check / Next, score, "Review missed", "Try again" (no new AI call)
- [ ] Study: closing and reopening the panel keeps the questions; reloading the page clears them
- [ ] Listen: the voice list has no novelty voices (Bubbles, Zarvox…); "Auto" reads with the best one
- [ ] `NODE_PATH=$(npm root -g) node testing/security/run.js` passes (backend running with
      `MOCK_LLM=1`). It checks the manifest, the reading view sanitizer, forged highlights,
      message sender checks, fingerprinting and the main features in a real Chromium.

## C. Picking the demo article
Pick 2 articles that work perfectly and keep their URLs here. Have a backup
(e.g. `testing/article.html` served locally) in case the Wi-Fi dies.
