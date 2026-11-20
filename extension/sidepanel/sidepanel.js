// Side panel UI logic. Talks only to background.js (which talks to the page and backend)
// and to chrome.storage.sync. Split into three plain scripts:
//   sidepanel.js     – shared helpers, page sync, hero, colors/legend   (this file)
//   reading-panel.js – "Reading comfort" card
//   listen-panel.js  – "Listen" card
//   keypoints-panel.js – "Key points" card (jump to a highlight)
//   study-panel.js   – "Study" card (questions before reading, quiz after)
// See docs/ACCESSIBILITY.md for the message contract.

const $ = (id) => document.getElementById(id);

// Background replies {ok, data} or {ok:false, error}. Never throws.
async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return res || { ok: false, error: "No answer" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// For messages the background forwards to the page: the page's own reply ({ok, ...})
// arrives in res.data. Flatten both levels into one {ok, error?, ...pageReply}.
async function pageCall(msg) {
  const res = await send(msg);
  if (!res.ok) return { ok: false, error: res.error };
  const d = res.data || {};
  if (d.ok === false) return { ok: false, error: d.error || "The page didn't answer." };
  return { ok: true, ...d };
}

// ---------- Page -> panel messages (SPEECH_STATE, PROGRESS, READER_STATE, HIGHLIGHTS_STATE) ----------
const pageListeners = {};
function onPageMessage(type, fn) { (pageListeners[type] ||= []).push(fn); }
function emitPage(type, payload) { (pageListeners[type] || []).forEach((fn) => fn(payload)); }

let panelWindowId = null; // the side panel belongs to one window
if (chrome.windows && chrome.windows.getCurrent) {
  chrome.windows.getCurrent().then((w) => (panelWindowId = w.id)).catch(() => {});
}

// Page -> panel messages come from our content scripts, which share a process with
// the web page: accept them only from the top frame of the tab this panel is showing
// (the active tab of our window), and treat what they carry as untrusted data.
function fromShownTab(sender) {
  const tab = sender && sender.tab;
  if (!tab) return false;
  if (sender.frameId != null && sender.frameId !== 0) return false;
  if (panelWindowId != null && tab.windowId != null && tab.windowId !== panelWindowId) return false;
  return tab.active !== false;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  // The background: the toolbar icon or a shortcut just gave Skimatic access to the
  // tab (or changed it), so look at the page again.
  if (msg && msg.type === "ACCESS_CHANGED" && sender && !sender.tab &&
      sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("background.js")) {
    resetForNewPage();
    return false;
  }
  if (!msg || !pageListeners[msg.type]) return false;
  if (!fromShownTab(sender)) return false;
  emitPage(msg.type, msg);
  return false; // we never answer; the background answers its own messages
});

// Ask the page what it's doing right now (on load and when the tab changes), and
// rebuild the panel from it: highlights, hidden roles, the master switch, reading
// view, speech and progress. A page we can't reach gets the defaults.
let syncSeq = 0;
async function syncPageState() {
  const seq = ++syncSeq;
  const res = await pageCall({ type: "GET_PAGE_STATE" });
  if (seq !== syncSeq) return; // the tab changed again while we waited
  const state = res.ok ? res : { reader: false, speech: null, progress: null };
  renderHighlightState(state);
  emitPage("READER_STATE", { open: !!state.reader });
  emitPage("SPEECH_STATE", { ...(state.speech || { state: "stopped", index: 0, total: 0, text: "" }), fromSync: true });
  emitPage("HIGHLIGHTS_STATE", state.highlights || { items: [], hiddenRoles: [] });
  emitPage("PROGRESS", state.progress || null);
}

const INTRO_STATUS = "Find the main point, evidence, background and the other side, in your colors.";

function renderHighlightState(state) {
  hiddenRoles.clear();
  (state.hiddenRoles || []).forEach((r) => hiddenRoles.add(r));
  document.querySelectorAll(".legend-row").forEach((row) => setRowVisible(row, !hiddenRoles.has(row.dataset.role)));
  setSwitch($("visible"), state.visible !== false);
  renderCounts(state.counts || null);
  const label = $("analyze").querySelector(".btn-label");
  if (isBusy($("analyze"))) return; // an analysis is running; it sets the text when done
  if (state.counts) {
    const n = state.found || 0;
    label.textContent = "Highlight again";
    setStatus(`${n} key sentence${n === 1 ? " is" : "s are"} highlighted on this page.`, "success");
  } else {
    label.textContent = "Highlight this article";
    setStatus(INTRO_STATUS);
  }
}

// "Developer tools" only in preview mode or when localStorage.scrDev === "1".
function devToolsAllowed() {
  if (globalThis.SCR_PREVIEW) return true;
  try { return localStorage.getItem("scrDev") === "1"; } catch { return false; }
}

// ---------- Hero ----------
function setStatus(text, kind = "") {
  const el = $("status");
  if (el.textContent !== text) el.textContent = text; // same text: don't re-announce it
  el.className = "status" + (kind ? " " + kind : "");
}

async function checkBackend() {
  const el = $("backend-status");
  const res = await send({ type: "HEALTH" });
  const [state, text, detail] = !res.ok
    ? ["offline", "Offline", "Can't reach the server: " + res.error]
    : res.data && res.data.mock
      ? ["mock", "Demo mode", "Server is running without an AI key (fake results)"]
      : ["ok", "Ready", "Connected to the server"];
  el.dataset.state = state;
  el.title = detail;
  el.querySelector(".status-text").textContent = text;
  el.querySelector(".status-detail").textContent = ": " + detail;
}

async function showPageTitle() {
  const res = await send({ type: "TAB_INFO" });
  // Chrome only tells us the title of a page Skimatic may access (no "tabs" permission).
  $("page-title").textContent = res.ok && res.data && res.data.title ? res.data.title.slice(0, 200) : "This page";
}

// Skimatic has no access to any site until the user points it at one: the toolbar icon
// or a keyboard shortcut (Chrome's activeTab), or "Use on every website".
const NO_ACCESS = "Skimatic can't read this tab yet. If it's a web page, click the Skimatic " +
  "icon in Chrome's toolbar while on it (or press Alt+Shift+H), then try again.";

function renderProgress(p) {
  const el = $("progress");
  // Only for a highlighted page: "you've reached the end" on a page nobody analyzed
  // (or just cleared) would be misleading.
  if (!p || !p.keyTotal) { el.hidden = true; el.textContent = ""; return; }
  const parts = [];
  if (p.keyTotal) parts.push(`${p.keySeen || 0} of ${p.keyTotal} key point${p.keyTotal === 1 ? "" : "s"} seen`);
  if (p.minutesLeft != null) {
    parts.push(p.minutesLeft > 0 ? `about ${p.minutesLeft} min left` : "you've reached the end");
  }
  el.textContent = parts.join(" · ");
  el.hidden = !parts.length;
}
onPageMessage("PROGRESS", renderProgress);

// Another tab (or a reload): show what that page has, not what the last one had.
function resetForNewPage() {
  showPageTitle();
  syncPageState();
  if (self.scrStudyRefresh) scrStudyRefresh(); // that tab's questions, if it has any
}
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener((info) => {
    if (panelWindowId == null || info.windowId === panelWindowId) resetForNewPage();
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (!tab.active || info.status !== "complete") return;
    if (panelWindowId == null || tab.windowId === panelWindowId) resetForNewPage();
  });
}

// aria-disabled instead of disabled, so a focused button never drops focus to <body>.
function setBusy(btn, busy) {
  btn.setAttribute("aria-disabled", String(busy));
  btn.toggleAttribute("aria-busy", busy);
}
const isBusy = (btn) => btn.getAttribute("aria-disabled") === "true";

$("analyze").addEventListener("click", async () => {
  const btn = $("analyze");
  if (isBusy(btn)) return;
  setBusy(btn, true);
  btn.classList.add("loading");
  btn.querySelector(".btn-label").textContent = "Reading…";
  setStatus("Reading the article and finding the key sentences…");

  const info = await send({ type: "TAB_INFO" });
  const res = info.ok && info.data && info.data.access === false
    ? (send({ type: "REQUEST_ACCESS" }), { ok: false, error: NO_ACCESS }) // also flags it in Chrome's toolbar
    : await send({ type: "ANALYZE_ACTIVE_TAB" });

  setBusy(btn, false);
  btn.classList.remove("loading");
  btn.querySelector(".btn-label").textContent = res.ok ? "Highlight again" : "Highlight this article";
  if (!res.ok) return setStatus(friendlyError(res.error), "error");

  const { found, paragraphs, highlights } = res.data;
  if (self.scrClearSpeechError) scrClearSpeechError(); // "No highlights yet" no longer applies
  renderCounts(countRoles(highlights));
  setSwitch($("visible"), true);
  setStatus(
    found
      ? `Highlighted ${found} key sentence${found === 1 ? "" : "s"} across ${paragraphs} paragraphs.`
      : "Couldn't match any sentences on this page. Try another article.",
    found ? "success" : "error"
  );
});

function friendlyError(err = "") {
  if (/Failed to fetch|NetworkError/i.test(err)) return "Can't reach the server. Is the backend running?";
  if (/Couldn't find an article/i.test(err)) return "This page doesn't look like an article.";
  if (/chrome:\/\/|chrome-extension:\/\/|extensions gallery|No active tab/i.test(err))
    return "Chrome doesn't let extensions read this page.";
  if (/Cannot access|must request permission|Receiving end does not exist/i.test(err)) return NO_ACCESS;
  return err;
}

// ---------- Switches (button role=switch) ----------
function setSwitch(btn, on) { btn.setAttribute("aria-checked", String(on)); }
const switchOn = (btn) => btn.getAttribute("aria-checked") === "true";

$("visible").addEventListener("click", () => {
  const on = !switchOn($("visible"));
  setSwitch($("visible"), on);
  send({ type: "SET_VISIBLE", visible: on });
  if (on && self.scrClearSpeechError) scrClearSpeechError();
});

// ---------- Legend + color picker ----------
// Rows are built once; color changes update them in place so focus is never lost.
const hiddenRoles = new Set();   // roles the reader switched off with the eye buttons (this page only)
let densityRoles = null;         // roles shown by the density setting (set by reading-panel.js)
let currentColors = { ...SCR_DEFAULT_COLORS };

const paletteName = (hex) =>
  (self.SCR_PALETTE_NAMES && SCR_PALETTE_NAMES[hex.toLowerCase()]) || `Custom color ${hex}`;
const sameColor = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function setRowVisible(row, visible) {
  row.classList.toggle("muted", !visible);
  row.querySelector(".eye").setAttribute("aria-pressed", String(visible));
}

function setDensityRoles(roles) {
  densityRoles = roles;
  document.querySelectorAll(".legend-row").forEach((row) => {
    const off = !!roles && !roles.includes(row.dataset.role);
    row.classList.toggle("density-off", off);
    row.querySelector(".legend-density").hidden = !off;
    // Tell screen reader users why "Show … highlights, pressed" has no effect right now.
    const eye = row.querySelector(".eye");
    if (off) eye.setAttribute("aria-describedby", `density-note-${row.dataset.role}`);
    else eye.removeAttribute("aria-describedby");
  });
}

function countRoles(highlights) {
  const counts = {};
  (highlights || []).forEach((h) => (counts[h.role] = (counts[h.role] || 0) + 1));
  return counts;
}

// counts = {role: n}, or null to hide the badges (page not highlighted).
function renderCounts(counts) {
  document.querySelectorAll(".legend-row").forEach((row) => {
    const badge = row.querySelector(".count");
    const n = (counts && counts[row.dataset.role]) || 0;
    badge.hidden = !counts;
    badge.querySelector(".count-n").textContent = n;
    badge.querySelector(".count-word").textContent = n === 1 ? " highlight" : " highlights";
  });
}

function rowFor(role) { return $("legend").querySelector(`.legend-row[data-role="${role}"]`); }

// Update one row (and the brand mark) to show `color`, without touching focus.
function paintRow(role, color) {
  const row = rowFor(role);
  if (!row) return;
  const r = SCR_ROLES.find((x) => x.key === role);
  row.style.setProperty("--c", color);
  row.querySelector(".swatch").setAttribute("aria-label", `${r.label} color: ${paletteName(color)}. Change color`);
  const radios = [...row.querySelectorAll('.palette-swatches [role="radio"]')];
  let checked = null;
  radios.forEach((b) => {
    const on = sameColor(b.dataset.color, color);
    b.setAttribute("aria-checked", String(on));
    if (on) checked = b;
  });
  // roving tabindex: the checked color (or the first one) is the tab stop
  const stop = checked || radios[0];
  radios.forEach((b) => (b.tabIndex = b === stop ? 0 : -1));
  const custom = row.querySelector('input[type="color"]');
  if (!sameColor(custom.value, color)) custom.value = color;
}

function paintBrand() {
  SCR_ROLES.slice(0, 3).forEach((r, i) =>
    document.documentElement.style.setProperty(`--swatch-${i + 1}`, currentColors[r.key])
  );
  // Every role's color as a variable too (the key points list uses them).
  SCR_ROLES.forEach((r) => document.documentElement.style.setProperty(`--role-${r.key}`, currentColors[r.key]));
}

let colorSaveTimer = null;
function pickColor(role, color) {
  currentColors = { ...currentColors, [role]: color };
  paintRow(role, color);
  paintBrand();
  // debounce: arrow keys change the color on every press, storage.sync has write quotas
  clearTimeout(colorSaveTimer);
  colorSaveTimer = setTimeout(async () => {
    colorSaveTimer = null;
    const saved = await scrLoadColors();
    await chrome.storage.sync.set({ colors: { ...saved, ...currentColors } });
  }, 250);
}

function openPalette(row, focusColor = true) {
  closePalettes(row);
  const palette = row.querySelector(".palette");
  palette.hidden = false;
  row.querySelector(".swatch").setAttribute("aria-expanded", "true");
  if (focusColor) {
    const radios = [...palette.querySelectorAll('[role="radio"]')];
    (radios.find((b) => b.getAttribute("aria-checked") === "true") || radios[0]).focus();
  }
}

function closePalette(row, returnFocus = false) {
  const palette = row.querySelector(".palette");
  if (palette.hidden) return;
  palette.hidden = true;
  const swatch = row.querySelector(".swatch");
  swatch.setAttribute("aria-expanded", "false");
  paintRow(row.dataset.role, currentColors[row.dataset.role]); // reset roving tab stop
  if (returnFocus) swatch.focus();
}

function closePalettes(exceptRow) {
  document.querySelectorAll(".legend-row").forEach((row) => row !== exceptRow && closePalette(row));
}

function buildLegend() {
  const ul = $("legend");
  ul.textContent = "";
  for (const role of SCR_ROLES) {
    const row = $("legend-row").content.firstElementChild.cloneNode(true);
    row.dataset.role = role.key;
    const cue = (self.SCR_ROLE_UNDERLINES || {})[role.key];
    if (cue) {
      row.style.setProperty("--cue-style", cue.style);
      row.style.setProperty("--cue-width", cue.thickness);
    }
    row.querySelector(".legend-label").textContent = role.label;
    row.querySelector(".legend-hint").textContent = role.hint;
    row.querySelector(".legend-density").id = `density-note-${role.key}`;

    const swatch = row.querySelector(".swatch");
    const palette = row.querySelector(".palette");
    const paletteId = `palette-${role.key}`;
    palette.id = paletteId;
    swatch.setAttribute("aria-controls", paletteId);

    const group = row.querySelector(".palette-swatches");
    group.setAttribute("aria-label", `Color for ${role.label}`);
    for (const c of SCR_PALETTE) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.color = c;
      b.style.setProperty("--c", c);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", "false");
      b.setAttribute("aria-label", paletteName(c));
      b.title = paletteName(c);
      b.addEventListener("click", () => pickColor(role.key, c));
      group.append(b);
    }
    group.addEventListener("keydown", (e) => {
      const radios = [...group.querySelectorAll('[role="radio"]')];
      const i = radios.indexOf(document.activeElement);
      if (i < 0) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      let j = null;
      if (step) j = (i + step + radios.length) % radios.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = radios.length - 1;
      if (j == null) return;
      e.preventDefault();
      pickColor(role.key, radios[j].dataset.color); // radio pattern: moving selects
      radios[j].focus();
    });

    const custom = row.querySelector('input[type="color"]');
    custom.addEventListener("input", () => pickColor(role.key, custom.value));

    swatch.addEventListener("click", (e) => {
      e.stopPropagation();
      palette.hidden ? openPalette(row) : closePalette(row);
    });
    palette.addEventListener("click", (e) => e.stopPropagation());
    row.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !palette.hidden) {
        e.preventDefault();
        e.stopPropagation();
        closePalette(row, true);
      }
    });
    // Close when focus moves to something outside this row (not when the native color
    // picker steals focus: relatedTarget is null then).
    row.addEventListener("focusout", (e) => {
      if (e.relatedTarget && !row.contains(e.relatedTarget)) closePalette(row);
    });

    const eye = row.querySelector(".eye");
    eye.setAttribute("aria-label", `Show ${role.label} highlights`);
    eye.addEventListener("click", () => {
      const visible = hiddenRoles.has(role.key);
      visible ? hiddenRoles.delete(role.key) : hiddenRoles.add(role.key);
      setRowVisible(row, visible);
      send({ type: "SET_ROLE_VISIBLE", role: role.key, visible });
      if (visible && self.scrClearSpeechError) scrClearSpeechError();
    });
    setRowVisible(row, true);
    ul.append(row);
  }
  renderCounts(null);
  setDensityRoles(densityRoles);
}

async function loadColors() {
  currentColors = await scrLoadColors();
  SCR_ROLES.forEach((r) => paintRow(r.key, currentColors[r.key]));
  paintBrand();
}

document.addEventListener("click", () => closePalettes());

$("reset-colors").addEventListener("click", async () => {
  clearTimeout(colorSaveTimer);
  await chrome.storage.sync.remove("colors");
  await loadColors();
});

$("clear").addEventListener("click", async () => {
  await send({ type: "CLEAR" });
  renderCounts(null);
  renderProgress(null);
  emitPage("HIGHLIGHTS_STATE", { items: [], hiddenRoles: [] }); // empty the key points list
  $("analyze").querySelector(".btn-label").textContent = "Highlight this article";
  setStatus("Highlights cleared.");
});

if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.colors && !colorSaveTimer) loadColors(); // e.g. another window
  });
}

// ---------- Collapsible cards (Reading comfort, Highlight colors) ----------
// A heading holding a button with aria-expanded (the disclosure pattern), so the
// heading stays in the screen reader's heading list. Open/closed is remembered in
// this browser only (a convenience; nothing breaks if storage is blocked).
document.querySelectorAll(".disclosure-btn").forEach((btn) => {
  const panel = $(btn.getAttribute("aria-controls"));
  const key = "scrOpen:" + panel.id;
  const show = (open) => {
    btn.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
  };
  try { show(localStorage.getItem(key) === "1"); } catch { show(false); }
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    show(open);
    try { localStorage.setItem(key, open ? "1" : "0"); } catch { /* private window */ }
  });
});

// ---------- Developer tools ----------
$("debug").hidden = !devToolsAllowed();
$("ping").addEventListener("click", async () => {
  const res = await send({ type: "PING_TAB" });
  const url = res.ok && res.data && (res.data.url || (res.data.data && res.data.data.url));
  setStatus(res.ok ? `Page answered: ${url}` : res.error, res.ok ? "" : "error");
});

// ---------- Start ----------
buildLegend();
loadColors();
checkBackend();
showPageTitle();
// reading-panel.js and listen-panel.js register their page listeners first.
document.addEventListener("DOMContentLoaded", syncPageState);
