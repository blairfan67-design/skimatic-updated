// Which read-aloud voices to offer, and which one "Auto" picks.
// Plain script (no imports), loaded by the side panel (<script>) and by background.js
// (importScripts), so both rank voices the same way.
//
// Input: voices from chrome.tts.getVoices(): {voiceName, lang, remote, ...}.
// Why a filter at all: macOS ships dozens of novelty voices (Bubbles, Zarvox, Bad News…)
// and old robotic ones (Fred, Ralph…). Listing them all made the dropdown long and
// most of them unpleasant to listen to for a whole article.

(function () {
  // Novelty, joke and very old voices. Matched against the first word(s) of the
  // voice name, before any "(English (US))" suffix.
  const DENY = [
    // macOS novelty voices
    "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "good news",
    "jester", "organ", "pipe organ", "superstar", "trinoids", "whisper", "wobble",
    "zarvox", "deranged", "hysterical",
    // old, robotic macOS voices
    "fred", "junior", "ralph", "kathy", "princess", "agnes", "bruce", "vicki", "victoria",
    // macOS "Eloquence" voices (shipped for every language, sound synthetic)
    "eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley",
  ];
  // Whole engines that sound robotic.
  const DENY_PATTERNS = [/\bespeak\b/i, /\bmbrola\b/i, /\bfestival\b/i, /\bcompact\b/i];

  // Signs of a high-quality voice (in the name Chrome reports).
  const HIGH = /\b(premium|enhanced|neural|natural|siri)\b/i;
  // Good everyday voices that don't say so in their name.
  const GOOD = /^(samantha|alex|ava|allison|susan|tom|zoe|evan|nathan|joelle|noelle|nicky|aaron|daniel|karen|moira|tessa|rishi|serena|kate|oliver|fiona|lee|google\b|microsoft (aria|jenny|guy|sonia|ryan|natasha|william))/i;

  const baseName = (name) => String(name || "").replace(/\s*\(.*$/, "").trim().toLowerCase();
  const primaryLang = (lang) => String(lang || "").toLowerCase().split(/[-_]/)[0];

  function isNovelty(voice) {
    const name = String((voice && voice.voiceName) || "");
    if (!name) return true;
    if (DENY.includes(baseName(name))) return true;
    return DENY_PATTERNS.some((re) => re.test(name));
  }

  // Higher is better. `uiLang` is e.g. "en-US".
  function score(voice, uiLang = "en-US") {
    const name = String(voice.voiceName || "");
    let s = 0;
    if (HIGH.test(name)) s += 40;
    else if (/^google\b/i.test(name)) s += 25;    // Chrome's network voices: natural, need internet
    else if (GOOD.test(name)) s += 15;
    if (/\bdesktop\b/i.test(name)) s -= 10;        // older Windows SAPI voices
    const lang = String(voice.lang || "").toLowerCase();
    const want = String(uiLang || "en-US").toLowerCase();
    if (lang === want) s += 6;                     // exactly the reader's language and region
    else if (primaryLang(lang) === primaryLang(want)) s += 3;
    if (!voice.remote) s += 1;                     // offline voices start faster
    return s;
  }

  const isHighQuality = (voice) => HIGH.test(String((voice && voice.voiceName) || ""));

  // The voices to offer: no novelty voices, only the reader's language (English
  // first when the reader's language isn't English), best first, at most `max`.
  const OFFER_MAX = 6; // how many voices the panel lists

  function rankVoices(voices, uiLang = "en-US", max = OFFER_MAX) {
    const langs = [...new Set([primaryLang(uiLang) || "en", "en"])];
    return (Array.isArray(voices) ? voices : [])
      .filter((v) => v && typeof v.voiceName === "string" && !isNovelty(v))
      .filter((v) => langs.includes(primaryLang(v.lang)))
      // dedupe by name (Chrome can report the same voice twice)
      .filter((v, i, all) => all.findIndex((w) => w.voiceName === v.voiceName) === i)
      .sort((a, b) =>
        langs.indexOf(primaryLang(a.lang)) - langs.indexOf(primaryLang(b.lang)) ||
        score(b, uiLang) - score(a, uiLang) ||
        a.voiceName.localeCompare(b.voiceName))
      .slice(0, max);
  }

  // "Auto (best available)": the top of the ranked list, or null (then Chrome's default).
  function bestVoice(voices, uiLang = "en-US") {
    return rankVoices(voices, uiLang, 1)[0] || null;
  }

  // The voice that will actually speak: the saved one only if the panel offers it
  // (top OFFER_MAX), else "Auto". Panel and background both call this, so the dropdown
  // always shows the voice the reader hears. Returns a voice object or null.
  function resolve(voices, wanted, uiLang = "en-US") {
    const offered = rankVoices(voices, uiLang, OFFER_MAX);
    const match = typeof wanted === "string" && wanted
      ? offered.find((v) => v.voiceName === wanted) : null;
    return match || offered[0] || null;
  }

  // Readable label, e.g. "Ava (Premium) · American English · High quality".
  // The tag tells readers which voices are worth picking without knowing the names.
  function voiceLabel(voice, uiLang = "en-US") {
    let language = voice.lang || "";
    try {
      const names = new Intl.DisplayNames([uiLang || "en"], { type: "language" });
      language = names.of(voice.lang) || language;
    } catch (e) { /* unknown language tag: keep the code */ }
    const name = voice.voiceName;
    const tag = HIGH.test(name) ? " · High quality" : /^google\b/i.test(name) ? " · Online" : "";
    return `${name}${language ? " · " + language : ""}${tag}`;
  }

  self.SCR_VOICES = { OFFER_MAX, isNovelty, score, isHighQuality, rankVoices, bestVoice, resolve, voiceLabel };
})();
