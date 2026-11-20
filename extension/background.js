importScripts("shared/roles.js", "shared/reading-settings.js", "shared/voices.js");

// Background service worker: the only part that talks to the backend.
// Side panel  -> background -> content script (extract) -> backend -> content script (paint)
//
// Security model (see README, "Permissions and security"):
//  - No static content scripts and no <all_urls>. The page scripts are injected only
//    into a tab the user pointed Skimatic at: activeTab (toolbar icon, keyboard
//    shortcuts) or a site the user allowed (optional_host_permissions).
//  - Every message is checked: who sent it (the side panel or one of our content
//    scripts) and what is in it. Web pages can't reach this listener at all (no
//    externally_connectable), but a content script shares a process with the page,
//    so its messages are treated as untrusted.

// Change this to your Render/Railway URL once the backend is deployed. Also update
// "host_permissions" and the CSP's connect-src in manifest.json to the same origin.
const BACKEND_URL = "http://localhost:8000";

// Clicking the toolbar icon opens the side panel. We open it ourselves from
// action.onClicked (not openPanelOnActionClick): a click handled this way is what
// grants activeTab, i.e. lets Skimatic read the tab the user clicked on.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
chrome.action.onClicked.addListener((tab) => {
  // Called right away, inside the click's user gesture (sidePanel.open needs one).
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.warn("[SCR] side panel", e));
  // The panel may already be open on this tab: tell it to look at the page again
  // (it can read it now). Nobody listening is fine.
  chrome.runtime.sendMessage({ type: "ACCESS_CHANGED" }).catch(() => {});
});

async function callBackend(path, body) {
  const res = await fetch(BACKEND_URL + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "omit", // the backend needs no cookies
  });
  if (!res.ok) {
    // FastAPI sends errors as {"detail": "human message"} (not part of docs/API_CONTRACT.md).
    // Show that message in the side panel; fall back to the raw status otherwise.
    const text = await res.text();
    let detail = null;
    try {
      detail = JSON.parse(text).detail;
    } catch (e) {
      // not JSON (proxy error page, etc.)
    }
    if (typeof detail === "string" && detail) throw new Error(detail.slice(0, 300));
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}
const activeTabId = async () => (await activeTab()).id;

// ---------- Talking to the page ----------
const CONTENT_SCRIPTS = [
  "lib/Readability.js", "shared/roles.js", "shared/reading-settings.js",
  "highlight.js", "content.js", "reading.js", "speech.js",
];
const CONTENT_CSS = ["content.css", "reading.css"];

// Inject the page scripts. Only works where Chrome gives us access (activeTab or a
// site the user allowed); anywhere else Chrome refuses, which is what we want.
async function injectInto(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
}

// Send a message to the page. If our scripts aren't there yet and `inject` is set,
// inject them and try again. Without `inject` (e.g. the panel just looking at a tab)
// a page Skimatic was never used on is left alone and gets `null`.
async function sendToTab(tabId, msg, { inject = true } = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (e) {
    if (!inject) return null;
    await injectInto(tabId);
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}

// ---------- Highlights per tab (for SIMPLIFY) ----------
// The content script never sends sentence text to the backend. It sends the index of
// a highlight, and we look up the sentence that /analyze returned for that tab. So a
// page can't use Skimatic to send its own text (or unlimited requests) to the AI.
// storage.session is in memory, survives service-worker restarts, and content scripts
// can't read it (default access level: trusted contexts only).
const hlKey = (tabId) => `hl:${tabId}`;
async function rememberHighlights(tabId, highlights) {
  await chrome.storage.session.set({ [hlKey(tabId)]: highlights.map((h) => String(h.text || "")) });
}
async function forgetHighlights(tabId) {
  await chrome.storage.session.remove(hlKey(tabId));
}
chrome.tabs.onRemoved.addListener((tabId) => { forgetHighlights(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") forgetHighlights(tabId).catch(() => {}); // a new page
});

// Ask the page for its article (Readability runs in the page). Shared by
// ANALYZE_ACTIVE_TAB and STUDY.
async function extractArticle(tabId) {
  const extracted = await sendToTab(tabId, { type: "EXTRACT" });
  const data = (extracted && extracted.data) || {};
  const title = typeof data.title === "string" ? SCR_cutText(data.title, 500) : "";
  // The page shapes what Readability returns: keep only well-formed paragraphs.
  const paragraphs = (Array.isArray(data.paragraphs) ? data.paragraphs : [])
    .filter((p) => p && Number.isInteger(p.id) && typeof p.text === "string")
    .slice(0, 80)
    .map((p) => ({
      id: p.id,
      text: SCR_cutText(p.text, 20000),
      // Optional section heading (the backend accepts at most 200 characters).
      heading: typeof p.heading === "string" ? SCR_cutText(p.heading, 200) : "",
    }));
  if (!paragraphs.length) throw new Error("Couldn't find an article on this page.");
  return { title, paragraphs };
}

async function analyzeActiveTab() {
  const tabId = await activeTabId();
  const { title, paragraphs } = await extractArticle(tabId);

  // The title and headings help the AI tell the main point from evidence and
  // background. The backend accepts a title of at most 300 characters.
  const result = await callBackend("/analyze", { title: SCR_cutText(title, 300), paragraphs });
  const highlights = (Array.isArray(result && result.highlights) ? result.highlights : [])
    .filter((h) => h && typeof h.text === "string" && SCR_ROLE_KEYS.includes(h.role))
    .map((h) => ({ paragraph_id: h.paragraph_id, text: h.text, role: h.role }));
  await rememberHighlights(tabId, highlights);
  const painted = await sendToTab(tabId, { type: "APPLY_HIGHLIGHTS", highlights });
  return { title, paragraphs: paragraphs.length, highlights, ...((painted && painted.data) || {}) };
}

// SIMPLIFY: rate limit per tab, and a small cache so clicking the same sentence
// again (or in the reading view) doesn't call the AI again.
const SIMPLIFY_LIMIT = 8;           // requests ...
const SIMPLIFY_WINDOW_MS = 10_000;  // ... per 10 seconds, per tab
const simplifyLog = new Map();      // tabId -> [timestamps]
const simplifyCache = new Map();    // sentence -> result (insertion order = age)

function allowSimplify(tabId) {
  const now = Date.now();
  const recent = (simplifyLog.get(tabId) || []).filter((t) => now - t < SIMPLIFY_WINDOW_MS);
  if (recent.length >= SIMPLIFY_LIMIT) return false;
  recent.push(now);
  simplifyLog.set(tabId, recent);
  return true;
}

async function simplify(msg, sender) {
  const tabId = sender.tab.id;
  const index = msg.index;
  if (!Number.isInteger(index) || index < 0) throw new Error("Bad highlight");
  const store = await chrome.storage.session.get(hlKey(tabId));
  const sentence = (store[hlKey(tabId)] || [])[index];
  if (typeof sentence !== "string" || !sentence) throw new Error("Unknown highlight");
  if (simplifyCache.has(sentence)) return simplifyCache.get(sentence);
  if (!allowSimplify(tabId)) throw new Error("Too many requests. Wait a few seconds and try again.");
  const result = await callBackend("/simplify", { sentence: sentence.slice(0, 2000) });
  const core = Array.isArray(result && result.core)
    ? result.core.filter((c) => typeof c === "string").slice(0, 20) : [];
  const clean = { core };
  simplifyCache.set(sentence, clean);
  if (simplifyCache.size > 200) simplifyCache.delete(simplifyCache.keys().next().value);
  return clean;
}

// ---------- Study: questions before reading, a quiz after (POST /study) ----------
// One AI call per article. The backend only reads the first ~25,000 characters, so we
// don't send more than that (less of the reader's page leaves the browser).
const STUDY_MAX_CHARS = 25_000;
// The answer is kept per tab (storage.session: in memory, trusted contexts only), so
// reopening the panel or coming back to the tab doesn't spend another AI call.
// A new page in that tab clears it (see forgetStudy below).
const studyKey = (tabId) => `study:${tabId}`;

function firstChars(paragraphs, max) {
  const out = [];
  let used = 0;
  for (const p of paragraphs) {
    if (used >= max) break;
    const text = p.text.slice(0, max - used);
    out.push({ id: p.id, text });
    used += text.length;
  }
  return out;
}

// The backend validates the AI's output already; we check the shape again, because
// whatever we hand the panel is rendered there (as text, never HTML).
const cleanText = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function cleanStudy(result, ids) {
  const known = (id) => Number.isInteger(id) && ids.has(id);
  const prequestions = (Array.isArray(result && result.prequestions) ? result.prequestions : [])
    .map((q) => ({ question: cleanText(q && q.question, 200), paragraph_id: q && q.paragraph_id }))
    .filter((q) => q.question && known(q.paragraph_id))
    .slice(0, 3);
  const quiz = (Array.isArray(result && result.quiz) ? result.quiz : [])
    .map((q) => ({
      question: cleanText(q && q.question, 200),
      options: Array.isArray(q && q.options) ? q.options.map((o) => cleanText(o, 120)) : [],
      answer: q && q.answer,
      explanation: cleanText(q && q.explanation, 200),
      paragraph_id: q && q.paragraph_id,
    }))
    .filter((q) => q.question && known(q.paragraph_id) &&
      q.options.length === 4 && q.options.every(Boolean) && new Set(q.options).size === 4 &&
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3)
    .slice(0, 5);
  return { prequestions, quiz };
}

async function studyActiveTab(msg) {
  const tab = await activeTab();
  const key = studyKey(tab.id);
  const url = (tab.url || "").split("#")[0];
  const stored = (await chrome.storage.session.get(key))[key];
  if (stored && url && stored.url === url) return { ...stored.data, cached: true };
  // The panel only asks what we already have (opening the panel, switching tabs).
  if (msg.cachedOnly) return null;

  const { title, paragraphs } = await extractArticle(tab.id);
  const result = await callBackend("/study", { paragraphs: firstChars(paragraphs, STUDY_MAX_CHARS) });
  const clean = cleanStudy(result, new Set(paragraphs.map((p) => p.id)));
  if (clean.quiz.length < 2) throw new Error("The AI didn't answer properly. Try again.");
  const data = { title, ...clean };
  if (url) await chrome.storage.session.set({ [key]: { url, data } });
  return data;
}

async function forgetStudy(tabId) {
  await chrome.storage.session.remove(studyKey(tabId));
}
chrome.tabs.onRemoved.addListener((tabId) => { forgetStudy(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") forgetStudy(tabId).catch(() => {}); // a new page
});

// ---------- Reading settings on every site (opt-in) ----------
// Off by default: the page scripts only run where the user used Skimatic. A reader
// who wants their reading settings applied everywhere turns this on in the panel,
// which first asks Chrome for access to all sites (optional_host_permissions).
const AUTO_ID = "scr-auto";
const ALL_SITES = ["http://*/*", "https://*/*"];

async function autoApplyOn() {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_ID] });
  return scripts.length > 0;
}

async function setAutoApply(on) {
  const registered = await autoApplyOn();
  if (on && !registered) {
    // Only when the user granted all-sites access (the panel asks first).
    if (!(await chrome.permissions.contains({ origins: ALL_SITES }))) {
      throw new Error("Skimatic needs access to all sites for this.");
    }
    await chrome.scripting.registerContentScripts([{
      id: AUTO_ID, matches: ALL_SITES, js: CONTENT_SCRIPTS, css: CONTENT_CSS,
      runAt: "document_idle", persistAcrossSessions: true,
    }]);
  }
  if (!on && registered) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_ID] });
  return { on: await autoApplyOn() };
}

// Access to all sites was taken back (chrome://extensions): stop auto-injecting.
chrome.permissions.onRemoved.addListener(async () => {
  if (!(await chrome.permissions.contains({ origins: ALL_SITES }))) setAutoApply(false).catch(() => {});
});

// ---------- Message validation ----------
const SPEECH_ACTIONS = ["pause", "resume", "stop", "next", "prev"];
const READER_ACTIONS = ["open", "close", "toggle"];
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// Every message forwarded to the page is rebuilt from checked fields, never passed on as-is.
// `inject: false` for commands that only make sense on a page Skimatic already runs on.
const forward = (build, opts) => async (msg) => sendToTab(await activeTabId(), build(msg), opts);

// Messages only the side panel may send.
const panelHandlers = {
  HEALTH: () => callBackend("/health"),
  TAB_INFO: async () => {
    // Without the "tabs" permission Chrome only shows url/title for tabs we may access.
    const tab = await activeTab();
    return { title: tab.title || "", url: tab.url || "", access: !!tab.url };
  },
  ANALYZE_ACTIVE_TAB: analyzeActiveTab,
  // No access to this tab yet: ask Chrome to show "Skimatic wants to access this site"
  // in its toolbar (Chrome 133+; older versions just get the panel's hint).
  REQUEST_ACCESS: async () => {
    if (!chrome.permissions.addHostAccessRequest) return { requested: false };
    try {
      await chrome.permissions.addHostAccessRequest({ tabId: await activeTabId() });
      return { requested: true };
    } catch (e) {
      return { requested: false }; // e.g. a chrome:// page, or a site we can't ever access
    }
  },
  PING_TAB: forward(() => ({ type: "PING", from: "side panel" })),
  SET_VISIBLE: forward((m) => ({ type: "SET_VISIBLE", visible: m.visible === true }), { inject: false }),
  SET_ROLE_VISIBLE: async (msg) => {
    if (!SCR_ROLE_KEYS.includes(msg.role)) throw new Error("Unknown role");
    return sendToTab(await activeTabId(), { type: "SET_ROLE_VISIBLE", role: msg.role, visible: msg.visible === true },
      { inject: false });
  },
  CLEAR: async () => {
    const tabId = await activeTabId();
    await forgetHighlights(tabId);
    return sendToTab(tabId, { type: "CLEAR" }, { inject: false });
  },
  // Reading comfort (see docs/ACCESSIBILITY.md for the message shapes):
  READER: async (msg) => {
    if (!READER_ACTIONS.includes(msg.action)) throw new Error("Unknown action");
    return sendToTab(await activeTabId(), { type: "READER", action: msg.action });
  },
  SPEAK: forward((m) => ({
    type: "SPEAK",
    scope: m.scope === "article" ? "article" : "highlights",
    rate: Math.min(2, Math.max(0.5, Number(m.rate) || 1)),
    voice: str(m.voice, 300),
  })),
  SPEECH_CONTROL: async (msg) => {
    if (!SPEECH_ACTIONS.includes(msg.action)) throw new Error("Unknown action");
    return sendToTab(await activeTabId(), { type: "SPEECH_CONTROL", action: msg.action }, { inject: false });
  },
  // Looking at a tab must not inject into it, unless reading settings are on (then the
  // user expects them on the tab they are looking at, if Chrome gives us access).
  GET_PAGE_STATE: async () => {
    const tabId = await activeTabId();
    const r = await scrLoadReading();
    try {
      return await sendToTab(tabId, { type: "GET_PAGE_STATE" }, { inject: !!(r.enabled || r.focusMode) });
    } catch (e) {
      return null; // no access to this tab: the panel shows the defaults
    }
  },
  // Reading settings changed in the panel: apply them to the tab the reader is on.
  // (Tabs that already have our scripts follow storage.onChanged on their own.)
  APPLY_READING: async () => {
    const r = await scrLoadReading();
    if (!(r.enabled || r.focusMode)) return null;
    return sendToTab(await activeTabId(), { type: "PING", from: "settings" });
  },
  // Key points list: scroll to one highlight (docs/ACCESSIBILITY.md, "Key points list").
  JUMP_TO: forward((m) => ({
    type: "JUMP_TO",
    id: /^\d{1,10}$/.test(String(m.id)) ? String(m.id) : "",
    role: SCR_ROLE_KEYS.includes(m.role) ? m.role : "",
    text: str(m.text, 2000),
    n: Number.isInteger(m.n) && m.n > 0 ? m.n : 1,
  }), { inject: false }),
  // Study card (docs/ACCESSIBILITY.md, "Study"). `cachedOnly`: never call the AI,
  // just say what this tab already has (or null).
  STUDY: (msg) => studyActiveTab({ cachedOnly: msg.cachedOnly === true }),
  // "Where?" / "Show in article": scroll the page to one of the article's paragraphs.
  JUMP_TO_PARAGRAPH: async (msg) => {
    const id = msg.paragraph_id;
    if (!Number.isInteger(id) || id < 0 || id >= 200) throw new Error("Bad paragraph");
    return sendToTab(await activeTabId(), { type: "JUMP_TO_PARAGRAPH", paragraph_id: id }, { inject: false });
  },
  AUTO_APPLY_STATE: async () => ({ on: await autoApplyOn() }),
  AUTO_APPLY: (msg) => setAutoApply(msg.on === true),
};

// ---------- Read aloud through Chrome's own speech engine ----------
// A web page may only speak after the reader clicked on it (Chrome reports
// "not-allowed" otherwise, which broke read-aloud started from the side panel).
// chrome.tts belongs to the extension, so it has no such rule. The content
// script still decides what to read and outlines it; we only speak.
const TTS_MAX_CHARS = 2000; // one sentence; anything longer is cut, never refused
let ttsTabId = null;        // the tab whose sentence is being spoken

// The reader's voice, or "Auto (best available)" when none is picked (""), or the
// picked one isn't installed here (settings sync between computers), or the panel
// doesn't offer it (novelty voice, other language, below the top 6). Same rule as the
// panel (SCR_VOICES.resolve), so the dropdown always names the voice that speaks.
async function voiceNameFor(wanted) {
  const voices = await new Promise((res) => chrome.tts.getVoices((v) => res(v || [])));
  const voice = SCR_VOICES.resolve(voices, wanted, navigator.language || "en-US");
  return voice ? voice.voiceName : undefined; // nothing suitable: Chrome's default voice
}

// Resolves when the sentence ends: {ended} | {interrupted} | {error}.
async function ttsSpeak(msg, sender) {
  const text = typeof msg.text === "string" ? msg.text.slice(0, TTS_MAX_CHARS) : "";
  if (!text.trim()) return { ended: true };
  const rate = Math.min(2, Math.max(0.5, Number(msg.rate) || 1));
  const voiceName = await voiceNameFor(msg.voice);
  ttsTabId = sender.tab.id;
  return new Promise((resolve) => {
    const options = {
      rate,
      enqueue: false, // a new sentence replaces the old one ("interrupted" for the old)
      onEvent: (e) => {
        if (e.type === "end") resolve({ ended: true });
        else if (e.type === "interrupted" || e.type === "cancelled") resolve({ interrupted: true });
        else if (e.type === "error") resolve({ error: e.errorMessage || "speech error" });
      },
    };
    if (voiceName) options.voiceName = voiceName;
    chrome.tts.speak(text, options, () => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
    });
  });
}

function ttsStop(_msg, sender) {
  // Only the tab that is speaking may silence it.
  if (sender && sender.tab && sender.tab.id === ttsTabId) chrome.tts.stop();
  return { ok: true };
}

// Stop talking when the reader closes or leaves that tab.
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === ttsTabId) chrome.tts.stop(); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === ttsTabId && info.status === "loading") chrome.tts.stop();
});

// Messages our content scripts may send (about their own tab only).
const contentHandlers = {
  SIMPLIFY: simplify,
  TTS_SPEAK: ttsSpeak,
  TTS_STOP: ttsStop,
};

const PANEL_URL = chrome.runtime.getURL("sidepanel/sidepanel.html");
const isPanel = (sender) => typeof sender.url === "string" && sender.url.split(/[?#]/)[0] === PANEL_URL;
// Content scripts: top frame of a real tab only (we never inject into subframes).
const isOurContentScript = (sender) => !!sender.tab && sender.frameId === 0 && Number.isInteger(sender.tab.id);

function handlerFor(msg, sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;
  if (isPanel(sender) && Object.hasOwn(panelHandlers, msg.type)) return panelHandlers[msg.type];
  if (!isPanel(sender) && isOurContentScript(sender) && Object.hasOwn(contentHandlers, msg.type)) {
    return contentHandlers[msg.type];
  }
  return null;
}

// Keyboard shortcuts (chrome://extensions/shortcuts to change them). A shortcut
// grants activeTab for the current tab, so these work on any normal web page.
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tabId = await activeTabId();
    if (command === "highlight-page") await analyzeActiveTab();
    if (command === "toggle-reader") await sendToTab(tabId, { type: "READER", action: "toggle" });
    if (command === "toggle-focus") {
      const reading = await scrLoadReading();
      await scrSaveReading({ focusMode: !reading.focusMode, preset: "custom" });
      await sendToTab(tabId, { type: "PING", from: "shortcut" }); // make sure this tab has it
    }
    chrome.runtime.sendMessage({ type: "ACCESS_CHANGED" }).catch(() => {}); // an open panel catches up
  } catch (e) {
    console.warn("[SCR] command failed", e);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlerFor(msg, sender);
  if (!handler) return false; // not for us (e.g. page -> panel updates), or not allowed
  Promise.resolve(handler(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the channel open for the async response
});

// For tests and debugging from the service-worker console.
self.handlers = panelHandlers;
