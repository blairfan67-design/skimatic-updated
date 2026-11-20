// Preview mode for the UI teammate. When sidepanel.html is opened as a normal web page
// (not inside the extension), this fakes the Chrome extension APIs so every button works.
// Inside the real extension it does nothing.
//
//   sidepanel.html                -> demo mode, analyze succeeds
//   sidepanel.html?state=offline  -> server offline, analyze fails
//   sidepanel.html?state=error    -> server ok, but the page isn't an article
//
// It also fakes the "Reading comfort" messages (READER, SPEAK, SPEECH_CONTROL,
// GET_PAGE_STATE, JUMP_TO), the Study card (STUDY, JUMP_TO_PARAGRAPH), chrome.tts
// voices (a Mac-like list with novelty voices, to see the filter) and sends fake page -> panel events (SPEECH_STATE, PROGRESS
// with seenIds / currentId, READER_STATE, HIGHLIGHTS_STATE) to chrome.runtime.onMessage
// listeners. Settings are kept in localStorage
// and chrome.storage.onChanged fires like the real thing. In the console:
//   scrPreview.emit({type: "PROGRESS", keySeen: 3, keyTotal: 12, minutesLeft: 4, percent: 40})
//   scrPreview.reset()   // forget saved colors + reading settings
(function () {
  if (globalThis.chrome && chrome.runtime && chrome.runtime.id) return; // real extension

  globalThis.SCR_PREVIEW = true; // shows "Developer tools" in the panel

  const state = new URLSearchParams(location.search).get("state") || "demo";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const store = {
    read() { try { return JSON.parse(localStorage.getItem("scr-preview") || "{}"); } catch { return {}; } },
    write(v) { try { localStorage.setItem("scr-preview", JSON.stringify(v)); } catch {} },
  };

  // A dozen realistic key points, in document order (2 main, 5 evidence,
  // 3 background, 2 other side), for the "Key points" list.
  const fakeHighlights = [
    { role: "main",       text: "Octopuses appear to cycle through two distinct stages of sleep, much like mammals and birds do." },
    { role: "background", text: "Until recently, most researchers assumed that invertebrates simply rested rather than truly slept." },
    { role: "evidence",   text: "In the lab, the animals' skin flashed through bursts of color roughly every hour during their quiet sleep." },
    { role: "evidence",   text: "These active bouts lasted only about a minute, and the octopuses were much harder to wake during them." },
    { role: "counter",    text: "Some biologists caution that color changes could be reflexes in the skin rather than signs of dreaming." },
    { role: "background", text: "An octopus has around 500 million neurons, two thirds of them spread through its eight arms." },
    { role: "evidence",   text: "Recordings from the brain showed fast, wake-like activity during the colorful phases of sleep." },
    { role: "main",       text: "The findings suggest that a two-stage sleep evolved separately in animals with complex brains." },
    { role: "evidence",   text: "When the researchers kept the octopuses awake, the animals made up for it with extra active sleep the next day." },
    { role: "background", text: "Octopuses and humans last shared a common ancestor more than 500 million years ago." },
    { role: "evidence",   text: "Cuttlefish, close relatives of the octopus, show a similar pattern of twitching and color changes at night." },
    { role: "counter",    text: "Because the study only followed a handful of animals in tanks, wild octopuses might sleep quite differently." },
  ].map((h, i) => ({ id: String(i + 1), ...h }));
  const ARTICLE_SENTENCES = 38;

  // What /study would return for the octopus article (shape: docs/API_CONTRACT.md).
  // The correct option is not always first: the backend shuffles them.
  const fakeStudy = {
    title: "Octopuses change color in their sleep",
    prequestions: [
      { question: "What do octopuses do with their skin while they sleep, and how often?", paragraph_id: 2 },
      { question: "Why might a two-stage sleep have evolved in such different animals?", paragraph_id: 7 },
      { question: "What makes some biologists doubt that octopuses dream?", paragraph_id: 4 },
    ],
    quiz: [
      { question: "About how often did the sleeping octopuses flash through bursts of color?",
        options: ["Every few seconds", "Roughly every hour", "Once a night", "Only when touched"], answer: 1,
        explanation: "The article says their skin flashed through bursts of color roughly every hour during quiet sleep.", paragraph_id: 2 },
      { question: "How long did the active, colorful sleep bouts last?",
        options: ["About ten minutes", "About half an hour", "About a minute", "Several hours"], answer: 2,
        explanation: "The active bouts lasted only about a minute, and the animals were harder to wake then.", paragraph_id: 3 },
      { question: "Where are most of an octopus's neurons?",
        options: ["In its central brain", "Spread through its arms", "In its eyes", "In its skin"], answer: 1,
        explanation: "About two thirds of its roughly 500 million neurons are spread through its eight arms.", paragraph_id: 5 },
      { question: "What happened when researchers kept the octopuses awake?",
        options: ["They slept less the next day", "They stopped changing color", "They became aggressive", "They made up for it with extra active sleep"], answer: 3,
        explanation: "Like mammals, they caught up with extra active sleep the next day.", paragraph_id: 8 },
      { question: "Why might wild octopuses sleep differently from the ones in the study?",
        options: ["The study followed only a few animals in tanks", "Wild octopuses have fewer neurons", "The tanks were kept dark all day", "Wild octopuses never change color"], answer: 0,
        explanation: "The study only followed a handful of animals in tanks, so wild behavior may differ.", paragraph_id: 11 },
    ],
  };
  const FAKE_PARAGRAPHS = 14;

  // A Mac-like chrome.tts voice list: a few good voices, many novelty ones.
  const fakeVoices = [
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester",
    "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Fred", "Junior", "Ralph",
    "Kathy", "Princess", "Grandma (English (US))", "Grandpa (English (US))", "Eddy (English (US))",
    "Flo (English (US))", "Reed (English (US))", "Rocko (English (US))", "Sandy (English (US))",
    "Shelley (English (US))",
  ].map((voiceName) => ({ voiceName, lang: "en-US", remote: false }))
    .concat([
      { voiceName: "Samantha", lang: "en-US", remote: false },
      { voiceName: "Ava (Premium)", lang: "en-US", remote: false },
      { voiceName: "Daniel", lang: "en-GB", remote: false },
      { voiceName: "Moira", lang: "en-IE", remote: false },
      { voiceName: "Google US English", lang: "en-US", remote: true },
      { voiceName: "Google UK English Female", lang: "en-GB", remote: true },
      { voiceName: "Zoe (Enhanced)", lang: "en-US", remote: false },
      { voiceName: "Thomas", lang: "fr-FR", remote: false },
      { voiceName: "Anna", lang: "de-DE", remote: false },
    ]);

  // ---- fake page state ----
  const page = {
    analyzed: false,
    reader: false,
    visible: true,
    hiddenRoles: new Set(),
    speech: { state: "stopped", index: 0, total: 0, text: "" },
    progress: null,
    at: 0,               // which key point the fake reader has scrolled to
    seen: new Set(),     // ids of key points already scrolled past
    jumped: null,        // id of the last JUMP_TO
  };
  let speechTimer = null;
  let scrollTimer = null;

  // ---- events to the panel ----
  const messageListeners = [];
  const storageListeners = [];
  const fakeSender = { tab: { id: 1, windowId: 1, active: true, url: "https://example.com/octopus" }, id: "preview" };
  function emit(msg) {
    console.log("[preview] page -> panel", msg);
    messageListeners.forEach((f) => { try { f(clone(msg), fakeSender, () => {}); } catch (e) { console.error(e); } });
  }
  function emitStorage(changes) {
    storageListeners.forEach((f) => { try { f(changes, "sync"); } catch (e) { console.error(e); } });
  }

  function sendSpeech() { emit({ type: "SPEECH_STATE", ...page.speech }); }
  function sendProgress() { if (page.progress) emit({ type: "PROGRESS", ...page.progress }); }

  // Which roles are not shown: everything with the master switch off, else the eye
  // buttons plus the density setting (like content.js).
  function readingNow() { return { ...SCR_READING_DEFAULTS, ...(store.read().reading || {}) }; }
  function hiddenRolesNow() {
    const all = SCR_ROLES.map((r) => r.key);
    if (!page.visible) return all;
    const shown = (SCR_DENSITY[readingNow().density] || SCR_DENSITY.all).roles;
    return all.filter((k) => page.hiddenRoles.has(k) || !shown.includes(k));
  }
  function sendHighlights() {
    emit({ type: "HIGHLIGHTS_STATE", items: page.analyzed ? fakeHighlights : [], hiddenRoles: hiddenRolesNow() });
  }

  // PROGRESS for the fake reader at key point `page.at` (only shown ones count).
  function setProgress() {
    const hiddenNow = new Set(hiddenRolesNow());
    const shown = page.analyzed ? fakeHighlights.filter((h) => !hiddenNow.has(h.role)) : [];
    const percent = Math.round((page.at / fakeHighlights.length) * 100);
    // "current" = the shown key point at (or after) where the reader is.
    const here = page.jumped || (fakeHighlights.slice(page.at).find((h) => !hiddenNow.has(h.role)) || {}).id || null;
    page.progress = {
      keySeen: shown.filter((h) => page.seen.has(h.id)).length,
      keyTotal: shown.length,
      minutesLeft: Math.max(0, Math.ceil(6 * (1 - percent / 100))),
      percent,
      seenIds: page.analyzed ? [...page.seen] : [],
      currentId: shown.length ? here : null,
    };
    sendProgress();
  }
  // pretend the reader scrolls: one more key point every 4 s. After a jump the
  // reader has seen the key point they jumped to.
  function startScrolling(from = 0) {
    clearInterval(scrollTimer);
    page.at = from;
    if (page.jumped) page.seen.add(page.jumped);
    setProgress();
    scrollTimer = setInterval(() => {
      if (page.at >= fakeHighlights.length - 1) return clearInterval(scrollTimer);
      page.at += 1;
      page.jumped = null; // the reader moved on from the jumped-to sentence
      page.seen.add(fakeHighlights[page.at].id);
      setProgress();
    }, 4000);
  }

  function sentence(i) { return `Preview sentence ${i + 1}: octopuses change color while they sleep.`; }
  function speakAt(i) {
    page.speech = { ...page.speech, state: "playing", index: i, text: sentence(i) };
    sendSpeech();
    clearTimeout(speechTimer);
    speechTimer = setTimeout(() => {
      if (page.speech.state !== "playing") return;
      if (i + 1 < page.speech.total) speakAt(i + 1);
      else stopSpeech();
    }, 2500 / (page.rate || 1));
  }
  function stopSpeech() {
    clearTimeout(speechTimer);
    page.speech = { state: "stopped", index: 0, total: 0, text: "" };
    sendSpeech();
  }

  const handlers = {
    HEALTH: async () => {
      await wait(400);
      if (state === "offline") throw new Error("Failed to fetch");
      return { status: "ok", mock: true };
    },
    TAB_INFO: async () => ({ title: "Octopuses change color in their sleep – Example News", url: "https://example.com", access: true }),
    REQUEST_ACCESS: async () => ({ requested: false }),
    APPLY_READING: async () => null,
    AUTO_APPLY_STATE: async () => ({ on: !!store.read().autoApply }),
    AUTO_APPLY: async (msg) => { store.write({ ...store.read(), autoApply: msg.on === true }); return { on: msg.on === true }; },
    ANALYZE_ACTIVE_TAB: async () => {
      await wait(1200);
      if (state === "offline") throw new Error("Failed to fetch");
      if (state === "error") throw new Error("Couldn't find an article on this page.");
      page.analyzed = true;
      page.seen.clear();
      page.jumped = null;
      setTimeout(() => { sendHighlights(); startScrolling(0); }, 50);
      return { title: "Preview", paragraphs: 14, found: 12, total: 12, highlights: fakeHighlights.map(({ role, text }) => ({ role, text })) };
    },
    PING_TAB: async () => ({ ok: true, url: "https://example.com (preview)" }),
    SET_VISIBLE: async (msg) => { page.visible = !!msg.visible; rolesChanged(); return { ok: true }; },
    SET_ROLE_VISIBLE: async (msg) => {
      page.hiddenRoles[msg.visible ? "delete" : "add"](msg.role);
      rolesChanged();
      return { ok: true };
    },
    CLEAR: async () => {
      page.analyzed = false;
      clearInterval(scrollTimer);
      page.seen.clear();
      page.jumped = null;
      if (page.speech.state !== "stopped") stopSpeech();
      setTimeout(() => { sendHighlights(); setProgress(); page.progress = null; }, 30);
      return { ok: true };
    },
    // Key points list: "scroll" to that key point (shows its role first if hidden).
    JUMP_TO: async (msg) => {
      await wait(80);
      let at = fakeHighlights.findIndex((h) => h.id === String(msg.id));
      // like content.js: an unknown (stale) id is looked up by role + sentence
      if (at < 0 && msg.role && msg.text) {
        const same = fakeHighlights.map((h, i) => [h, i]).filter(([h]) => h.role === msg.role && h.text === msg.text);
        at = same[(Number(msg.n) || 1) - 1] ? same[(Number(msg.n) || 1) - 1][1] : -1;
      }
      if (!page.analyzed || at < 0) return { ok: false, error: "That highlight is no longer on the page." };
      const role = fakeHighlights[at].role;
      let revealed = null;
      if (hiddenRolesNow().includes(role)) {
        revealed = { role, master: !page.visible, eye: page.hiddenRoles.has(role), density: null };
        page.visible = true;
        page.hiddenRoles.delete(role);
        const before = readingNow();
        if (!(SCR_DENSITY[before.density] || SCR_DENSITY.all).roles.includes(role)) {
          // like content.js: the smallest density that shows this role, saved
          const level = role === "main" ? "main" : role === "evidence" ? "main-evidence" : "all";
          revealed.density = { from: before.density, to: level, presetWas: before.preset };
          storageSet({ reading: { ...before, density: level, preset: "custom" } });
        }
        setTimeout(sendHighlights, 20);
      }
      page.jumped = fakeHighlights[at].id;
      setTimeout(() => startScrolling(at), 300); // the "smooth scroll" lands
      return revealed ? { ok: true, id: fakeHighlights[at].id, revealed } : { ok: true, id: fakeHighlights[at].id };
    },

    // ---- Study card ----
    // Like background.js: the answer is kept for this "tab" until it changes, so
    // cachedOnly (panel opened / tab switched) never "calls the AI".
    STUDY: async (msg) => {
      if (page.study) return { ...page.study, cached: true };
      if (msg.cachedOnly) return null;
      await wait(1400);
      if (state === "offline") throw new Error("Failed to fetch");
      if (state === "error") throw new Error("Couldn't find an article on this page.");
      page.study = clone(fakeStudy);
      return clone(page.study);
    },
    JUMP_TO_PARAGRAPH: async (msg) => {
      await wait(80);
      const id = msg.paragraph_id;
      if (!Number.isInteger(id) || id < 0 || id >= FAKE_PARAGRAPHS) {
        return { ok: false, error: "That part of the article isn't on the page." };
      }
      console.log("[preview] page scrolled to paragraph", id);
      return { ok: true };
    },

    // ---- Reading comfort (replies are shaped like the page's replies) ----
    READER: async (msg) => {
      await wait(150);
      if (state === "error") return { ok: false, error: "Couldn't find an article on this page." };
      page.reader = msg.action === "toggle" ? !page.reader : msg.action === "open";
      setTimeout(() => {
        emit({ type: "READER_STATE", open: page.reader });
        if (page.analyzed) sendHighlights(); // the real page re-paints the highlights
        sendProgress();
      }, 30);
      return { ok: true, open: page.reader };
    },
    SPEAK: async (msg) => {
      await wait(150);
      if (msg.scope === "highlights") {
        if (!page.analyzed) return { ok: false, error: "No highlights yet" };
        // Same errors as speech.js when the highlights exist but none are shown.
        if (!page.visible) return { ok: false, error: "Highlights are switched off" };
        const reading = { ...SCR_READING_DEFAULTS, ...(store.read().reading || {}) };
        const shown = (SCR_DENSITY[reading.density] || SCR_DENSITY.all).roles;
        const anyShown = fakeHighlights.some((h) => shown.includes(h.role) && !page.hiddenRoles.has(h.role));
        if (!anyShown) return { ok: false, error: "Highlights are hidden" };
      }
      page.rate = msg.rate || 1;
      page.speech.total = msg.scope === "highlights" ? fakeHighlights.length : ARTICLE_SENTENCES;
      setTimeout(() => speakAt(0), 30);
      return { ok: true, total: page.speech.total };
    },
    SPEECH_CONTROL: async (msg) => {
      const s = page.speech;
      if (s.state === "stopped") return { ok: true };
      switch (msg.action) {
        case "pause": clearTimeout(speechTimer); page.speech = { ...s, state: "paused" }; sendSpeech(); break;
        case "resume": speakAt(s.index); break;
        case "stop": stopSpeech(); break;
        case "next": if (s.index + 1 < s.total) { s.state === "playing" ? speakAt(s.index + 1) : (page.speech = { ...s, index: s.index + 1, text: sentence(s.index + 1) }, sendSpeech()); } else stopSpeech(); break;
        case "prev": { const i = Math.max(0, s.index - 1); s.state === "playing" ? speakAt(i) : (page.speech = { ...s, index: i, text: sentence(i) }, sendSpeech()); break; }
      }
      return { ok: true };
    },
    GET_PAGE_STATE: async () => {
      if (state === "error") return { ok: false, error: "Couldn't find an article on this page." };
      const counts = {};
      fakeHighlights.forEach((h) => (counts[h.role] = (counts[h.role] || 0) + 1));
      return {
        ok: true, reader: page.reader, speech: { ...page.speech }, progress: page.progress && { ...page.progress },
        counts: page.analyzed ? counts : null, found: page.analyzed ? fakeHighlights.length : 0,
        hiddenRoles: [...page.hiddenRoles], visible: page.visible,
        highlights: { items: page.analyzed ? fakeHighlights : [], hiddenRoles: hiddenRolesNow() },
      };
    },
  };

  // Eye buttons, master switch or density changed: the page re-sends both.
  function rolesChanged() {
    if (!page.analyzed) return;
    setTimeout(() => { sendHighlights(); setProgress(); }, 20);
  }

  function storageSet(obj) {
    const before = store.read();
    store.write({ ...before, ...clone(obj) });
    const changes = {};
    for (const k of Object.keys(obj)) changes[k] = { oldValue: before[k], newValue: clone(obj[k]) };
    setTimeout(() => emitStorage(changes), 0);
    const oldDensity = (before.reading || {}).density || "all";
    if (obj.reading && (obj.reading.density || "all") !== oldDensity) rolesChanged();
  }

  const tabListeners = [];
  globalThis.chrome = {
    runtime: {
      async sendMessage(msg) {
        console.log("[preview] message", msg);
        try {
          const h = handlers[msg.type];
          return { ok: true, data: h ? await h(msg) : { ok: true } };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      onMessage: {
        addListener: (f) => messageListeners.push(f),
        removeListener: (f) => { const i = messageListeners.indexOf(f); if (i >= 0) messageListeners.splice(i, 1); },
      },
    },
    storage: {
      sync: {
        async get(key) {
          const s = store.read();
          if (key == null) return clone(s);
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map((k) => [k, clone(s[k])]));
        },
        async set(obj) { storageSet(obj); },
        async remove(key) {
          const s = store.read();
          const keys = Array.isArray(key) ? key : [key];
          const changes = {};
          keys.forEach((k) => { changes[k] = { oldValue: s[k] }; delete s[k]; });
          store.write(s);
          setTimeout(() => emitStorage(changes), 0);
        },
      },
      onChanged: { addListener: (f) => storageListeners.push(f) },
    },
    tabs: {
      onActivated: { addListener: (f) => tabListeners.push(f) },
      onUpdated: { addListener() {} },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tts: { getVoices: (cb) => setTimeout(() => cb(clone(fakeVoices)), 0) },
    // "Use on every website": the preview always says yes to the permission prompt.
    permissions: { request: async () => true, remove: async () => true },
  };

  // Console helpers for trying states by hand.
  globalThis.scrPreview = {
    emit,
    page,
    reset() { store.write({}); location.reload(); },
    switchTab() { page.study = null; page.analyzed = false; page.reader = false; page.progress = null; page.visible = true; page.hiddenRoles.clear(); page.seen.clear(); page.jumped = null; clearInterval(scrollTimer); stopSpeech(); tabListeners.forEach((f) => f({ tabId: 2, windowId: 1 })); },
  };
  console.log(`[preview] Skimatic side panel in preview mode (state=${state})`);
})();
