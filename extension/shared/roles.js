// Shared by the content script, side panel and background (plain script, no imports).
// The four role keys must match docs/API_CONTRACT.md.
self.SCR_ROLES = [
  { key: "main",       label: "Main point", hint: "The claim the author wants you to remember", defaultColor: "#f2c14e" },
  { key: "evidence",   label: "Evidence",   hint: "Data, examples and quotes that back it up",  defaultColor: "#8cc084" },
  { key: "background", label: "Background", hint: "Context you need to follow along",           defaultColor: "#7fb3d5" },
  { key: "counter",    label: "Other side", hint: "Caveats, limits and objections",             defaultColor: "#e8a0bf" },
];

// Cut page text to at most `max` characters without splitting an emoji or other
// astral character: String.prototype.slice counts UTF-16 code units, and a lone
// surrogate left at the cut makes the backend reject the whole request (422).
// toWellFormed() also replaces any lone surrogate already in the page text.
self.SCR_cutText = (s, max) => {
  let out = String(s).slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out.toWellFormed ? out.toWellFormed() : out;
};

// The only role names we accept from the backend or the page (anything else is dropped).
self.SCR_ROLE_KEYS = self.SCR_ROLES.map((r) => r.key);

// Curated swatches offered in the color picker. Chosen to stay readable as a light
// wash on both white and dark pages. UI teammate: re-check these in a colorblind
// simulator (e.g. Chrome DevTools > Rendering > Emulate vision deficiencies).
self.SCR_PALETTE = [
  "#f2c14e", "#f4a259", "#e8a0bf", "#c39bd3",
  "#7fb3d5", "#76c7c0", "#8cc084", "#c9b79c",
];

// Human names for the palette colors (keyed by lowercase hex), read out by screen readers.
self.SCR_PALETTE_NAMES = {
  "#f2c14e": "Sunflower yellow", "#f4a259": "Apricot orange", "#e8a0bf": "Rose pink",
  "#c39bd3": "Lavender", "#7fb3d5": "Sky blue", "#76c7c0": "Teal",
  "#8cc084": "Sage green", "#c9b79c": "Sand",
};

// Non-color cue per role (same underline the page draws under each highlight, WCAG 1.4.1).
self.SCR_ROLE_UNDERLINES = {
  main:       { style: "solid",  thickness: "2px",   label: "solid underline" },
  evidence:   { style: "dotted", thickness: "2px",   label: "dotted underline" },
  background: { style: "dashed", thickness: "2px",   label: "dashed underline" },
  counter:    { style: "wavy",   thickness: "1.5px", label: "wavy underline" },
};

self.SCR_DEFAULT_COLORS = Object.fromEntries(
  self.SCR_ROLES.map((r) => [r.key, r.defaultColor])
);

// Colors are saved in chrome.storage.sync so they stay the same on every article.
self.scrLoadColors = async function () {
  const { colors } = await chrome.storage.sync.get("colors");
  return { ...self.SCR_DEFAULT_COLORS, ...(colors || {}) };
};
