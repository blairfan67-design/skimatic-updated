# Reading comfort: dyslexia- and ADHD-friendly features

This is the spec and the contract for the "Reading comfort" features. Both the page
side (content scripts) and the side panel build against it. Settings shapes live in
`extension/shared/reading-settings.js`.

**Naming and claims.** Call it "Reading comfort", never "Dyslexia mode", and don't
claim it treats anything. People vary a lot, and the best-supported principle is
that readers can adjust things themselves. So everything here is opt-in and adjustable.

## Evidence summary (what we build and why)

| Feature | Evidence | Notes |
|---|---|---|
| Larger text (18–24px) | moderate | Rello et al. 2013 (W4A); Rello & Baeza-Yates 2017 |
| Extra letter/word spacing | moderate / weak | Zorzi et al. 2012 PNAS; WCAG 1.4.12 values 0.12em / 0.16em |
| Line height 1.5, shorter lines (≤ 65–70ch) | weak/mixed | Schneps et al. 2013: helps some subgroups |
| Sans fonts (Verdana, Atkinson Hyperlegible, Lexend) | weak/mixed | Rello & Baeza-Yates 2013. **"Dyslexia fonts" (OpenDyslexic, Dyslexie) showed no benefit, so we don't ship them** |
| Cream / tinted themes | weak/mixed (comfort only) | Colored overlays don't treat dyslexia (Griffiths 2016, Suttle 2018). Offered as a preference |
| Clean reading view (declutter) | moderate (general readers) | No ADHD-specific trial; removes animated ads and clutter |
| Read aloud, sentence by sentence | moderate | Bimodal reading aids comprehension for students with reading difficulties; keep it opt-in |
| Focus mode (dim other paragraphs) | weak/mixed | Rulers raise perceived attention, not comprehension; must not break contrast |
| Fewer highlights (density) | weak/mixed | Selective signaling helps; too many colors overwhelm |
| Keyboard access, non-color role cues, contrast | strong (WCAG A/AA) | Requirements, not extras |

**Myths we deliberately do NOT build:** Bionic Reading (Snell 2024: no effect), auto-advancing
speed reading, BeeLine color gradients, gamification (streaks/confetti), "ADHD fonts".
Dimming never breaks contrast: we dim text by mixing its color (never below 65%, and only as far
as 4.5:1 allows), not with opacity on whole blocks, which also fades highlights and links.

## Settings (chrome.storage.sync key `reading`)

See `SCR_READING_DEFAULTS` in `shared/reading-settings.js`. The content scripts listen to
`chrome.storage.onChanged` and apply changes live. The panel writes via `scrSaveReading(patch)`,
then sends `APPLY_READING` so the tab the reader is on gets the page scripts if it doesn't have
them yet (only when text settings or focus mode are on, and only where Chrome gives Skimatic
access; see README, "Permissions and security").

The page scripts are not on every site. They are injected into a tab when the reader uses
Skimatic there (toolbar icon, a keyboard shortcut, or a panel button on a tab Skimatic may
access). The switch **Use on every website** (reading comfort card) is the opt-in for the old
behaviour: it asks Chrome for access to all sites, then the background registers the page
scripts for every http(s) page (`chrome.scripting.registerContentScripts`, id `scr-auto`).
Turning it off unregisters them and gives the permission back.

Privacy: the page can read `<html>`'s `style` and classes, so the page scripts only write a
reader's values there while they are in use: role colors once the page is highlighted, text
variables while text settings are on or the reading view is open.
Any manual change sets `preset: "custom"`; picking a preset writes `{...SCR_READING_PRESETS[p], preset: p}`.

## Messages

Panel → background → page (background forwards these to the active tab via `sendToTab`).
The background accepts these only from the side panel page (it checks `sender.url`), checks
every field (known `action`/`role`/`scope` values, numbers in range, string lengths) and
forwards a rebuilt message, never the one it received. The page accepts messages only from the
extension itself (`sender.id`, no `sender.tab`). A message type the background doesn't know, or
from a sender that may not send it, gets no answer.

| type | payload | page replies |
|---|---|---|
| `READER` | `{action: "open" \| "close" \| "toggle"}` | `{ok, open: bool}` |
| `SPEAK` | `{scope: "highlights" \| "article", rate, voice}` | `{ok, total}` (starts from the first sentence; if `scope=highlights` and there are no highlights, `{ok:false, error:"No highlights yet"}`; if the page is highlighted but none are shown, `error:"Highlights are switched off"` (master switch off) or `"Highlights are hidden"` (every role hidden by the eye buttons / density)) |
| `SPEECH_CONTROL` | `{action: "pause" \| "resume" \| "stop" \| "next" \| "prev"}` | `{ok}` |
| `GET_PAGE_STATE` | — | `{ok, reader: bool, speech: SpeechState, progress: Progress \| null, counts: {role: n} \| null, found: number, hiddenRoles: string[], visible: bool}` |

`GET_PAGE_STATE` never injects into a page Skimatic wasn't used on (unless text settings or focus
mode are on); for such a page, or one Skimatic may not access, the background answers `data: null`
and the panel shows its defaults.

`GET_PAGE_STATE` lets the panel rebuild itself after a tab switch: `progress` is null on a page
that was never analyzed or set up; `counts` is the number of highlights per role the backend sent
(null when the page isn't highlighted); `found` is how many highlights are painted; `hiddenRoles`
are the roles switched off with the eye buttons (`SET_ROLE_VISIBLE`, not density); `visible` is the
master switch (`SET_VISIBLE`).

Page → panel (the content script calls `chrome.runtime.sendMessage`; the background ignores these
and the side panel listens with `chrome.runtime.onMessage`; always `.catch(() => {})` because
the panel may be closed):

| type | payload |
|---|---|
| `SPEECH_STATE` | `{state: "playing" \| "paused" \| "stopped", index, total, text, error?}` (index is 0-based; `error` is a reader-facing sentence, only when reading stopped because the voice failed) |
| `PROGRESS` | `{keySeen, keyTotal, minutesLeft, percent}` — sent at most every 500ms while scrolling, right after highlights are applied, when the shown roles change (eye buttons, density, master switch; `keyTotal` counts shown highlights only, so it is 0 with the master switch off), and after CLEAR (then `keyTotal` is 0). The panel hides the line when `keyTotal` is 0 |
| `READER_STATE` | `{open: bool}` — sent whenever the reading view opens or closes (also via Esc / keyboard shortcut) |

Page → background:

| type | payload | reply |
|---|---|---|
| `SIMPLIFY` | `{index}`: the highlight's position in the list `APPLY_HIGHLIGHTS` delivered | `{ok, data: {core: [string]}}` or `{ok:false, error}` |

The page never sends the sentence itself. The background keeps the sentences `/analyze`
returned for each tab (`chrome.storage.session`, which content scripts can't read), looks up
`index` for the sender's own tab, and refuses unknown indexes. It caches results and allows at
most 8 backend calls per tab per 10 seconds. Only real clicks / key presses (`event.isTrusted`)
on marks the extension painted itself start a simplify; a page script calling `mark.click()`,
or a `<mark class="scr-hl">` the page made, does nothing.

Background → panel: `ACCESS_CHANGED` (no payload) after the toolbar icon or a keyboard shortcut,
so an open panel looks at the page again.

Keyboard shortcuts (manifest `commands`, handled in background.js): Alt+Shift+H highlights the
article; Alt+Shift+R toggles the reading view; Alt+Shift+F toggles focus mode. Each one also gives
Skimatic access to the current tab (Chrome's activeTab).

## Page side (content scripts: `content.js`, `reading.js`, `speech.js`, `highlight.js`, `content.css`, `reading.css`)

Script order: Readability → roles → reading-settings → highlight → content → reading → speech
(`CONTENT_SCRIPTS` in background.js).

Our own marks: `highlight.js` keeps every `<mark>` it creates, with its id and role, in a private
map (`SCR.isOwnMark`, `SCR.marksIn(root)`, `SCR.idOf(mark)`, `SCR.roleOf(mark)`). Page-side code
must use these, never `querySelectorAll("mark.scr-hl")` or `mark.dataset.scrId/scrRole` on their
own: a page can create look-alike marks or edit our attributes. The `data-scr-*` attributes are
only there for `content.css`.

Reading view: Readability's article HTML is rebuilt from an allowlist (`cleanArticleNodes` in
`reading.js`): fresh elements made with `document.createElement`, only a few attributes copied
(`href` for http/https/mailto/#, `src` for http/https images, `alt`, `title`, table spans...), text
copied as text. Unknown elements are unwrapped; scripts, forms, embeds, media and svg/math are
dropped. Never move parsed nodes into the page (`adoptNode`/`append` of DOMParser nodes): inline
`on*` handlers survive `removeAttribute` that way and run in the page.
`content.js` exposes what the others need on `self.SCR_PAGE`:
`{ extractArticle, applyHighlights(highlights, root?), getHighlights(), getRoot(), markBlocks(root?), announce(text) }`.

1. **Article blocks.** `markBlocks()` finds the live elements (p, li, blockquote, h1–h4) whose
   normalized text matches a paragraph Readability extracted. It adds `scr-block` and
   `data-scr-block="<i>"`, and adds `scr-root` to their lowest common ancestor. Stray matches
   outside the article (a paragraph quoted in the comments) are dropped: only blocks inside the
   deepest element holding ≥ 85% of the matches count. It runs on EXTRACT, and lazily when a
   reading setting needs it. The Readability parse is cached per URL (ignoring `#hash`); when the
   URL changes (single-page apps) or the cached parse matches no live block, the page is parsed
   again. Our own marks and block markers are removed from the clone before parsing. All page styling is scoped to `.scr-block` (inside `.scr-root`);
   never restyle the whole host page, or non-block headings and widgets inside the root.
2. **Text settings** (`html.scr-read`). CSS variables on `<html>`:
   `--scr-font --scr-size --scr-ls --scr-ws --scr-lh --scr-lw`, applied with `!important` to
   `.scr-root .scr-block`: font-family (skip when font=site), font-size,
   letter-spacing, word-spacing, line-height. Blocks get `max-inline-size: var(--scr-lw)`.
   Inside blocks: `em, i, cite` become `font-style: normal; font-weight: 600`;
   `text-align: start`; no justification; no auto-hyphens.
3. **Themes** (`html.scr-theme-<name>`). Set `--scr-bg --scr-fg --scr-fade --scr-link` from
   `SCR_THEMES`. Apply bg/fg to the blocks only, always together (links use `--scr-link`;
   other descendants inherit the fg on a transparent background). Don't paint `.scr-root`:
   non-block text there keeps the site's color and must keep the site's background.
   Theme `site` changes nothing.
4. **Fonts.** Bundle `fonts/atkinson-hyperlegible-{400,700}.woff2` and `fonts/lexend-{400,700}.woff2`
   (from the `@fontsource/atkinson-hyperlegible` and `@fontsource/lexend` npm packages, latin
   subset, unmodified) plus their `OFL.txt` license files. Inject `@font-face` with
   `chrome.runtime.getURL`, families `"SCR Atkinson"` / `"SCR Lexend"`, `font-display: swap`.
5. **Clean reading view** (`READER`). A full-screen overlay `#scr-reader` with role=dialog,
   aria-modal=true and aria-labelledby the title, at z-index 2147483647, with its own scroll and
   `html { overflow: hidden }` while open. It has a header (article title, "Close (Esc)" button)
   and a body built from a fresh Readability parse's `article.content`; strip script/style/iframe/form/object,
   SVG animation elements (animate/set/animateMotion/animateTransform/discard), any `on*`
   attributes and any attribute whose value is a `javascript:`/`vbscript:` URL (after removing
   whitespace and control characters). The overlay's `scroll-padding-top` follows the sticky
   header's measured height so focused items are never hidden under it; when the header is
   taller than a quarter of the viewport it stops being sticky. Long words may break
   (`overflow-wrap: anywhere`) so large text never scrolls sideways. It always uses the text settings values, and theme = cream when
   the setting is `site`. Highlights are re-applied inside the overlay (`root = overlay`); on
   close they are re-applied to the page. Focus moves to the close button on open and returns
   to the previously focused element on close. Esc closes. Blocks inside the overlay are
   `scr-block` too. The overlay carries `data-scr-theme="<theme>"` (dark-theme highlight colors).
   Links keep `--scr-link`. Send `READER_STATE` on every change.
6. **Focus mode** (`html.scr-focus`). The active block (`.scr-active`) is unchanged; in the
   other `.scr-block`s the plain text is drawn at `--scr-dim` of its color
   (`-webkit-text-fill-color: color-mix(in srgb, currentColor var(--scr-dim), transparent)`).
   `reading.js` computes `--scr-dim` per block (set inline on each `.scr-block`), from every
   text color in that block and the background behind it: the lowest share that keeps ≥ 4.5:1
   for all of them, never below 65% (100% if any text is already below 4.5:1). A block
   without its own value isn't dimmed.
   Highlights, links and backbone words keep full strength. The active block
   follows the pointer (pointerover, debounced ~120ms), the `j`/`k` keys (only when focus mode
   is on and focus isn't in an input/textarea/contenteditable; it scrolls the block into view
   with `block:"center"`), and the sentence currently being read aloud. The color
   transition is 150ms and none under prefers-reduced-motion.
7. **Density.** The hidden roles are those not in `SCR_DENSITY[density].roles`, plus the roles
   switched off with the panel's eye buttons (existing `SET_ROLE_VISIBLE`). Apply both through
   the existing `html.scr-hide-<role>` classes. Track them separately so one doesn't undo the other.
8. **Non-color role cue** (always on, WCAG 1.4.1). Each role gets a distinct underline style as
   well as its wash: main = solid 2px, evidence = dotted 2px, background = dashed 2px,
   counter = wavy 1.5px. Use `text-decoration` with `text-underline-offset: .2em` and a
   darker mix of the role color as the decoration color (55% role color + black). In the dark
   theme (page or reading view) the wash is thinner (22%, 30% on hover) and the line is the
   role color mixed with white, so it keeps ≥ 3:1 against both the wash and the background.
   The same dark values apply on a site that is dark on its own (`html.scr-dark-site`, set by
   `content.js` when the background behind the article blocks has relative luminance < 0.18;
   re-checked after highlights are painted and when the theme changes).
9. **Keyboard + screen readers on highlights.** The first `<mark>` of each highlight id gets
   `tabindex=0`, `role=button`, `aria-pressed=false` and
   `aria-label="<Role label>: <sentence>. Press Enter for the sentence backbone."`.
   Enter/Space toggles the backbone view, like a click. A visually hidden
   `#scr-live` (aria-live=polite) region in the page announces "Simplifying…",
   "Backbone: <core pieces>" and "Couldn't simplify this sentence." Use a visible
   `:focus-visible` outline.
10. **Backbone contrast.** `.scr-faded` draws the text color at 80% over the wash
    (`-webkit-text-fill-color`, not opacity), which keeps ≥ 4.5:1 on every theme's wash with every
    palette color. Under prefers-reduced-motion, loading shows a static dashed outline instead of a pulse.
11. **Read aloud** (`speech.js`). One sentence at a time through `chrome.tts` (spoken by background.js, because a page's own `speechSynthesis` is blocked until the reader clicks the page) (this avoids
    Chrome's ~15s cutoff). With scope=highlights the queue is the highlight sentences in
    document order (in the current root); with scope=article it's every block split into
    sentences (`Intl.Segmenter` with sentence granularity, falling back to a regex). The
    sentence being read gets `.scr-speaking` (a 2px solid outline, no background change) on
    its marks or block. In focus mode its block becomes `.scr-active`. Scroll into view only
    when it's off screen (instant scrolling under reduced motion). Controls:
    pause/resume/stop/next/prev. Send `SPEECH_STATE` on every change (the Stop control always
    sends one, so the panel can resync). Changes to `speechRate` / `speechVoice` in storage apply
    from the next sentence. When an utterance fails, stop and send `SPEECH_STATE` with `error`.
    Stop on page unload and when highlights are cleared.
12. **Progress.** An IntersectionObserver on the first mark of each highlight counts which
    were seen (≥ 50% visible). `minutesLeft` = words in the blocks below the viewport bottom
    / 230, rounded up. `percent` = share of blocks scrolled past. Send `PROGRESS` (throttled
    to 500ms) on scroll, when highlights are applied, and when the reading view opens or closes.

## Side panel (`sidepanel/*`, `dev-stub.js`)

- **Hero card.** Add a progress line under the status: "4 of 12 key points seen · about 6 min
  left". This is plain text, not live (it would be too chatty).
- **Card order** (default view): hero (Highlight) → Key points → Study → Listen → Reading comfort
  (collapsed) → Highlight colors (collapsed; its "Show" switch stays visible). The collapsed cards
  use a heading that holds a disclosure button (`aria-expanded`, `aria-controls`), so they stay in
  the screen reader's heading list; the open/closed state is remembered per browser (localStorage).
- **"Reading comfort" card**:
  - Presets as a radio group (segmented look): Off · Easy reading · Focus. It shows "Custom"
    when the settings don't match a preset. Each has a one-line honest description.
  - "Open clean reading view" button (toggles to "Close reading view"; follows `READER_STATE`).
  - A "Text" disclosure (`<details>`, collapsed by default) with: font `<select>`
    (`SCR_FONTS`); range sliders with visible values and `<label>`s for size, letter spacing,
    word spacing, line height and line width; the theme as a radio group of swatches, each
    with a text label; a "Reset text settings" button.
  - A "Focus mode" switch (role=switch) with the hint "Dims other paragraphs. Move with your
    mouse or the J / K keys."
  - Highlight density as a radio group (`SCR_DENSITY` labels).
- **New "Listen" card:** play/pause toggle, stop, previous and next buttons (icon buttons with
  aria-labels, ≥ 32px); a scope radio (Highlighted sentences / Whole article); a speed slider
  (0.7–1.5×); a voice `<select>` (see "Voices" below); and the state text "Reading sentence 3
  of 12" with role=status.
- **Apply the reader's text settings to the panel itself**: font family plus letter/word spacing
  (the size scales the panel's root font-size from size/20, clamped to 0.9–1.3).
- **Audit fixes (all required):**
  - Picking a color must not rebuild the legend and lose focus; update rows in place.
  - Swatch button: aria-expanded plus aria-controls, no aria-haspopup; the palette sits right
    after the swatch in DOM order; focus goes to the selected color when opened; Esc closes and
    returns focus to the swatch.
  - Palette: `role=radiogroup` with aria-label "Color for Main point"; each color has a human
    name (add `SCR_PALETTE_NAMES` next to `SCR_PALETTE` in roles.js); arrow keys move between
    colors (roving tabindex).
  - Eye toggle: static aria-label "Show Main point highlights", aria-pressed, and a slashed-eye
    icon when off.
  - Master switch: role=switch, aria-label "Show highlights on the page", and the off track gets
    a visible border.
  - Reflow at 200% zoom and in a 180px-wide panel with no horizontal scroll
    (`main{grid-template-columns:minmax(0,1fr)}`, and the page title wraps instead of ellipsis).
  - Use rem font sizes; the smallest text is 0.8125rem.
  - Targets ≥ 24px (eye buttons and swatches ≥ 28px).
  - Swatch borders reach ≥ 3:1.
  - `#backend-status` gets role=status, with detail text in the DOM (visually hidden), not just in title.
  - Count badges are announced: "5 highlights".
  - "Developer tools" is hidden unless in preview mode (dev-stub) or `localStorage.scrDev === "1"`.
    "Clear highlights" moves into the colors card as a normal text button.
  - Legend rows show each role's underline style (the same non-color cue as the page).
- **`dev-stub.js`** must fake every new message (READER, SPEAK, SPEECH_CONTROL, GET_PAGE_STATE)
  and emit fake SPEECH_STATE / PROGRESS events to the panel's `chrome.runtime.onMessage`
  listeners, so the whole UI can be previewed without the extension.

## Key points list (jump to a highlight)

A "Key points" card in the side panel, placed right after the hero card. It lists every highlight
painted on the page (or in the reading view) in document order. Clicking an item jumps to that
sentence. This helps ADHD readers find their place again and gives keyboard and screen-reader
users an outline of the article.

**Contract additions**

Page → panel:

| type | payload |
|---|---|
| `HIGHLIGHTS_STATE` | `{items: [{id, role, text}], hiddenRoles: [role]}`. Sent after highlights are applied, cleared, or re-painted (reading view open/close), and when the set of hidden roles changes (density, eye buttons, master switch). `items` has only highlights that were actually found on the page, in document order (only marks the extension painted, with a known role). `id` is the mark's id (digits) in the current root. `text` is the full sentence. `hiddenRoles` lists roles that are currently not shown; when the master switch is off, it lists all four. |
| `PROGRESS` (extended) | Also gets `seenIds: [id]` (highlights already seen) and `currentId` (the shown highlight nearest the top third of the viewport, or `null`). |

`GET_PAGE_STATE` also returns `highlights: {items, hiddenRoles}`. The panel treats both as
untrusted (they come from the page's process): it keeps only items with a known role, a numeric
id and a string sentence (capped in length and number), and accepts page → panel messages only
from the top frame of the tab it is showing.

Panel → background → page:

| type | payload | page replies |
|---|---|---|
| `JUMP_TO` | `{id, role, text, n}` | `{ok, id, revealed?}`, or `{ok:false, error:"That highlight is no longer on the page."}` |

`role`, `text` and `n` are the panel's row key (role, full sentence, and which repeat of that
sentence, 1-based). Ids change on every re-paint (reading view open/close), so a `JUMP_TO` sent
just before one can carry a stale id: the page then finds the highlight by role + sentence + `n`.
The reply's `id` is the id it actually jumped to. If the jump still fails, the panel fetches
`GET_PAGE_STATE`, re-keys its rows and retries once; only then does it show the error, and it puts
"you are here" (`aria-current`) back where it was. A `HIGHLIGHTS_STATE` clears that error.

`revealed` is present only when the role was hidden and the page had to show it:
`{role, master, eye, density: {from, to, presetWas} | null}` (`master`: the master switch was off;
`eye`: the role's eye button was off; `density`: "Highlights to show" was changed from `from` to
`to`, and `presetWas` is the preset before the change).

On `JUMP_TO` the page:
- scrolls the first mark of that highlight to the center (`behavior: "smooth"`, or `"auto"`
  under prefers-reduced-motion), inside the reading view when it's open;
- outlines all of its marks with `.scr-flash` for about 1.5s (a static outline under reduced
  motion, with no animation);
- moves keyboard focus to the first mark (`focus({preventScroll: true})`), so Enter then shows
  the backbone;
- in focus mode, makes its block `.scr-active`;
- announces "Jumped to <role label>." through `#scr-live`.

If the highlight's role is hidden, the page shows that role first (as if its eye button were
pressed back on) and sends `HIGHLIGHTS_STATE`, so jumping never lands on an invisible sentence.

**Revealing a hidden role is never silent (COGA "make it predictable", WCAG 3.2).** The chosen
behaviour: the page makes the change for real, so the panel's controls never disagree with the
page, and the panel says what changed in `#kp-status` (`role="status"`), which stays until the
next jump:
- master switch off → it is switched back on (page only, like the switch itself); the status
  adds "Highlights on the page are switched on again (the “Show” switch).";
- eye button off → that role is shown again (page only, like the eye button); the status says
  "Showing <role> highlights again so you can see this one.";
- hidden by "Highlights to show" → the smallest density that includes the role is chosen and
  **saved** to `chrome.storage.sync` with `preset: "custom"` (it applies to every tab and later
  sessions, and the Reading comfort card updates). The status names the new value, e.g.
  "Showing Other side highlights again so you can see this one. “Highlights to show” is now All 4."
  and adds ", and the reading preset is now Custom." when a named preset was active.

**Panel UI**
- The card heading is "Key points", with a count, e.g. "Key points (12)".
- Filter chips as a radio group: All · Main point · Evidence · Background · Other side, each with
  its count. This filter is panel-only; it doesn't change the page. Chips for roles with 0
  items are disabled.
- The list is an `<ol>` of buttons, one per item, with:
  - a role marker: a small swatch in the reader's color plus that role's underline style,
    the same non-color cue as the page;
  - the role label;
  - the sentence, clamped to 3 lines with the full text in the accessible name;
  - a ✓ when seen (the accessible name gets ", already seen"), drawn in `--ok-ink` (light
    #3f6b39: ≥ 4.99:1 on card, paper and the current-item background; dark #93c48a: ≥ 6.5:1).
- The current item gets `aria-current="location"` and a left accent bar.
- Items for hidden roles stay in the list but are marked "(hidden)" and are dimmed at ≥ 4.5:1
  contrast. Clicking one unhides that role.
- Keyboard: one Tab stop for the list (roving tabindex). Up/Down/Home/End move between items;
  Enter or Space jumps. The focused item keeps focus after the jump, because the page focus is
  in another document.
- The panel scrolls the current item into view only when the reader hasn't touched the list in
  the last 5s (never steal attention).
- Empty state: "Click “Highlight this article” and the key points will show up here."
- Must work in preview mode (dev-stub fakes `HIGHLIGHTS_STATE`, `JUMP_TO` incl. `revealed` and the role + sentence fallback, `currentId` / `seenIds`).

## Study: questions before reading, a quiz after

A "Study" card right after Key points. Two evidence-based study habits, kept calm:

| Feature | Evidence | Notes |
|---|---|---|
| Pre-questions ("Before you read") | moderate | Asking questions before reading improves memory for the asked-about content (Carpenter & Toftness 2017; Pan & Sana 2021) |
| Retrieval practice ("After you read") | strong | Testing yourself beats re-reading (Roediger & Karpicke 2006; Adesope et al. 2017 meta-analysis), with feedback and an explanation after each answer |

Deliberately **not** built: timers, streaks, confetti, points, sounds (gamification adds pressure
and distraction, especially for ADHD readers).

**Messages** (panel → background; only the side panel may send them):

| type | payload | reply |
|---|---|---|
| `STUDY` | `{cachedOnly?: bool}` | `{title, prequestions: [{question, paragraph_id}], quiz: [{question, options[4], answer, explanation, paragraph_id}], cached?}`; with `cachedOnly`, `null` when this tab has nothing yet (never calls the AI) |
| `JUMP_TO_PARAGRAPH` | `{paragraph_id}` (integer 0–199, checked) | forwarded to the page (no injection): `{ok}` or `{ok:false, error:"That part of the article isn't on the page."}` |

- The background extracts the article like `ANALYZE_ACTIVE_TAB` (`EXTRACT`), sends at most the
  first 25,000 characters of paragraphs to `POST /study` (one AI call; see docs/API_CONTRACT.md),
  checks every field again, and keeps the answer per tab in `chrome.storage.session` (memory only,
  not readable by content scripts) together with the page URL. A new page in that tab
  (`tabs.onUpdated` loading) or closing the tab clears it. So reopening the panel or switching
  back to the tab shows the same questions without another AI call; quiz progress is kept per page
  while the panel stays open.
- **Paragraph ids vs page blocks.** The ids are the indexes of the paragraphs `EXTRACT` sent (long
  enough, no headings), while `data-scr-block` numbers every block on the page (headings too), so
  the two can differ. The page finds the block whose normalized text equals that paragraph's text
  (first 60 characters as a fallback). An id with no extracted paragraph (out of range, or the
  page changed) replies `{ok:false, error:"That part of the article isn't on the page."}`; it is
  never guessed from `data-scr-block`, which uses a different numbering.
  Inside the reading view it searches the reading view's blocks.
- On `JUMP_TO_PARAGRAPH` the page scrolls the block to the center (`smooth`, or `auto` under
  reduced motion), outlines it with `.scr-flash` for ~1.5s (static under reduced motion), moves
  focus to it (borrowing `tabindex=-1`, removed again on blur), makes it `.scr-active` in focus
  mode and announces "Jumped to that part of the article." through `#scr-live`.

**Panel UI**
- "Before you read": "Get questions" (busy state on the button). Then 3 questions in an `<ol>`
  with "Keep these in mind while you read." Answers are never shown. Each question has a
  "Where?" button (accessible name "Where? Question 2") that jumps to the paragraph, hidden until
  the reader presses "Show where" (`aria-expanded`), so readers try to remember first.
- "After you read": "Quiz me" (uses the same answer; calls the AI only if nothing was loaded yet).
  Starting the quiz folds "Before you read" to one "Show the 3 questions" button
  (`aria-expanded`, `aria-controls="pre-body"`), so the quiz starts near the top of the card;
  "Try again" unfolds it.
  One question at a time, "Question 2 of 5" (focus moves there), the question as the `<legend>`
  of a `<fieldset>` with 4 native radios (arrow keys move, one Tab stop). "Check" with nothing
  picked says "Pick an answer first." After checking, the radios are read-only, the right option
  says "✓ Correct answer" and a wrong pick "✗ Your answer" (color **and** words), the explanation
  and "Show in article" appear, and "Check" turns into "Next" (focus moves to it). A visually
  hidden `aria-live="polite"` region reads the result and explanation.
- End: score "4 of 5" (focus moves there) and one plain sentence; "Review missed" walks through
  the missed questions with the right answer and scrolls the page to each; "Try again" shuffles
  the questions and options locally (no AI call).
- Errors (no access, offline, no article, rate limit, daily quota, bad AI answer) use the same
  friendly messages as the hero, in `#study-status` (`role=status`).
- AI text is always set with `textContent`.
- A `STUDY` reply that arrives after the reader switched tabs (or the page changed) is dropped
  (a generation counter in study-panel.js), so one tab's questions never show while another tab
  is in front; background.js has kept them for their own tab.

## Voices (Listen card)

The voice list comes from `chrome.tts.getVoices()`, the engine background.js speaks with, through
`extension/shared/voices.js` (loaded by the panel and, with `importScripts`, by the service worker,
so both rank voices the same way):

- **Removed:** macOS novelty and joke voices (Albert, Bad News, Bahh, Bells, Boing, Bubbles,
  Cellos, Good News, Jester, Organ, Pipe Organ, Superstar, Trinoids, Whisper, Wobble, Zarvox,
  Deranged, Hysterical), old robotic ones (Fred, Junior, Ralph, Kathy, Princess, Agnes, Bruce,
  Vicki, Victoria), the "Eloquence" voices (Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy,
  Shelley) and eSpeak/MBROLA/Festival/"compact" engines.
- **Kept:** voices in the reader's language (`navigator.language`) and English, best first:
  names with Premium / Enhanced / Neural / Natural / Siri ("High quality" in the label), then
  Chrome's Google voices ("Online"), then known good system voices (Samantha, Daniel, …). At most 6.
- **"Auto · <voice>"** is the default (`speechVoice: ""`); it names the voice Auto picks right now.
  background.js resolves it on every sentence with the same ranking, so a newly installed Premium
  voice is used right away. A saved voice the dropdown doesn't offer (not installed here, deny
  list, other language, or below the top 6) also plays as Auto: panel and background both call
  `SCR_VOICES.resolve()`, so the dropdown always shows the voice you hear.
- Hint under the dropdown, shown only on a Mac with no Premium/Enhanced voice installed (elsewhere
  it's hidden and not in the select's `aria-describedby`): "Want a better voice? On a Mac: System Settings → Accessibility →
  Spoken Content → System voice → Manage voices, and download a Premium voice."
- Default speed stays 1.0×.

## Panel look: frosted glass (and how it stays accessible)

Chrome's side panel can't show the web page behind it, so the "transparent" look is the panel's
own soft, tinted backdrop showing through translucent cards (`rgba` surfaces, hairline borders,
no drop shadows, one muted accent, 8px spacing scale, three corner radii, serif only for the brand
and the article title). The real frosted glass (`backdrop-filter: blur()`) is the sticky
masthead, which the cards scroll under; the cards themselves aren't blurred (over smooth
gradients the blur was invisible and cost a GPU layer per card).

- Contrast is measured on the drawn result: each translucent surface composited over the darkest
  and lightest part of the backdrop, light and dark. Lowest measured: text 5.0:1 (light) / 5.1:1
  (dark), UI borders 3.6:1. Re-measure when changing a token. Exception: the idle Listen buttons
  (stop / previous / next, `aria-disabled="true"` while nothing is read) have a hairline ring;
  inactive controls are exempt from 1.4.11, their glyphs stay ≥ 4.5:1, and the full border
  returns when reading starts.
- `@media (prefers-contrast: more)`: opaque surfaces and masthead, darker borders, no blur.
- `@supports not (backdrop-filter)`: nearly opaque surfaces and a solid masthead, so text never
  sits on a muddy mix.
- Focus rings, targets ≥ 24px (quiz rows ≥ 36px; the whole row is the label), 180px / 200% zoom
  reflow and reduced motion work as before.
