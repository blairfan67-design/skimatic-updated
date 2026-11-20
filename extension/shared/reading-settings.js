// Reading-comfort settings: shared by content scripts, side panel and preview stub.
// Plain script (no imports). Stored in chrome.storage.sync under the key "reading".
// See docs/ACCESSIBILITY.md for what each setting does and the evidence behind it.

self.SCR_READING_DEFAULTS = {
  preset: "off",            // "off" | "easy" | "focus" | "custom"  (UI label only)
  enabled: false,           // apply text settings + theme to the article on the page
  font: "site",             // "site" | "sans" | "atkinson" | "lexend"
  size: 20,                 // px, 16–28 step 2
  letterSpacing: 0.12,      // em, 0–0.25 step 0.01   (WCAG 1.4.12 value)
  wordSpacing: 0.16,        // em, 0–0.5 step 0.02    (WCAG 1.4.12 value)
  lineHeight: 1.5,          // unitless, 1.3–1.8 step 0.05
  lineWidth: 65,            // ch, 40–80 step 5
  theme: "site",            // "site" | "cream" | "greyblue" | "dark"
  focusMode: false,         // dim every paragraph except the one you're on
  density: "all",           // "all" | "main-evidence" | "main"
  speechRate: 1,            // 0.7–1.5 step 0.1
  speechVoice: "",          // chrome.tts voiceName, "" = Auto (best available, shared/voices.js)
  speechScope: "highlights" // "highlights" | "article"
};

self.SCR_READING_PRESETS = {
  off:  { enabled: false, font: "site", theme: "site", focusMode: false, density: "all" },
  easy: { enabled: true, font: "atkinson", size: 20, letterSpacing: 0.12, wordSpacing: 0.16,
          lineHeight: 1.5, lineWidth: 65, theme: "cream", focusMode: false, density: "all" },
  focus:{ enabled: true, font: "atkinson", size: 20, letterSpacing: 0.12, wordSpacing: 0.16,
          lineHeight: 1.5, lineWidth: 60, theme: "cream", focusMode: true, density: "main-evidence" },
};

self.SCR_FONTS = {
  site:     { label: "Site's font", stack: "" },
  sans:     { label: "Simple sans (Verdana)", stack: 'Verdana, Arial, Helvetica, sans-serif' },
  atkinson: { label: "Atkinson Hyperlegible", stack: '"SCR Atkinson", Verdana, Arial, sans-serif' },
  lexend:   { label: "Lexend", stack: '"SCR Lexend", Verdana, Arial, sans-serif' },
};

// Every theme keeps body text >= 7:1 and faded text >= 4.5:1.
self.SCR_THEMES = {
  site:     { label: "Site colors" },
  cream:    { label: "Cream",     bg: "#FBF7EC", fg: "#222222", fade: "#6B6B6B", link: "#1A4F8B" },
  greyblue: { label: "Grey-blue", bg: "#EEF2F6", fg: "#1F2933", fade: "#596470", link: "#1A4F8B" },
  dark:     { label: "Dark",      bg: "#1E1E1E", fg: "#E6E3DD", fade: "#A3A09A", link: "#8AB4F8" },
};

// Which roles each density level shows.
self.SCR_DENSITY = {
  "all":           { label: "All 4",            roles: ["main", "evidence", "background", "counter"] },
  "main-evidence": { label: "Main + evidence",  roles: ["main", "evidence"] },
  "main":          { label: "Main points only", roles: ["main"] },
};

self.scrLoadReading = async function () {
  const { reading } = await chrome.storage.sync.get("reading");
  return { ...self.SCR_READING_DEFAULTS, ...(reading || {}) };
};

self.scrSaveReading = async function (patch) {
  const current = await self.scrLoadReading();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ reading: next });
  return next;
};
