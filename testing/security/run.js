// Security + regression tests for the extension, in a real Chromium with Playwright.
//
//   cd backend && MOCK_LLM=1 .venv/bin/uvicorn main:app --port 8000     (in another terminal)
//   NODE_PATH=$(npm root -g) node testing/security/run.js
//
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium).
// The script serves testing/ on :5500 and testing/security/pages on :5600 itself,
// and stops them (and the browser) when it ends.
//
// Skimatic has no access to any site until the user allows it (toolbar icon,
// keyboard shortcut, or "Use on every website"). A test can't click Chrome's toolbar,
// so most tests run on a temporary copy of the extension whose manifest grants the
// two test origins, standing in for "the user allowed this site". The first group
// runs on the real, unmodified extension.

const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "../..");
const EXT = path.join(ROOT, "extension");
const BACKEND = "http://localhost:8000";
const ARTICLE = "http://localhost:5500/article.html";
const FIX = "http://127.0.0.1:5600";

let failures = 0;
function check(name, ok, detail = "") {
  detail = String(detail).split("\n")[0];
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny static servers (+ /hit collector for "did the exploit fire?") ----------
const hits = [];
function serve(dir, port, host, mounts = {}) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/hit") {
      hits.push(url.searchParams.get("v"));
      res.end("ok");
      return;
    }
    let base = dir;
    let rel = decodeURIComponent(url.pathname);
    for (const [prefix, mounted] of Object.entries(mounts)) {
      if (rel.startsWith(prefix)) { base = mounted; rel = rel.slice(prefix.length - 1); }
    }
    const file = path.join(base, path.normalize(rel));
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

// ---------- browser helpers ----------
async function launch(extDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "scr-prof-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    // --enable-unsafe-extension-debugging: lets the test "click" the toolbar icon (CDP).
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--enable-unsafe-extension-debugging"],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  return { ctx, sw, id, profile };
}

async function close({ ctx, profile }) {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

// Send messages from Skimatic's content-script world of the active tab, the way a
// compromised page renderer could. (Isolated worlds don't allow eval, so the probe is
// written out here and handed to executeScript as a function.)
function sendFromContentWorld(sw, messages) {
  return sw.evaluate(async (messages) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "ISOLATED", args: [messages],
      func: async (messages) => {
        const out = [];
        for (const m of messages) {
          try { out.push(await chrome.runtime.sendMessage(m)); } catch (e) { out.push("error " + e.message); }
        }
        return out;
      },
    });
    return r.result;
  }, messages);
}

const toTab = (sw, msg) => sw.evaluate(async (msg) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return chrome.tabs.sendMessage(tab.id, msg);
}, msg);

// A copy of the extension that is allowed on the two test origins.
function grantedCopy(origins = ["http://localhost:5500/*", "http://127.0.0.1:5600/*"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-ext-"));
  fs.cpSync(EXT, dir, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  mf.host_permissions.push(...origins);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(mf, null, 2));
  return dir;
}

// ======================================================================
async function testManifest() {
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  check("manifest: no static content_scripts", !mf.content_scripts);
  check("manifest: no <all_urls> / wildcard host_permissions",
    !(mf.host_permissions || []).some((h) => /<all_urls>|^\*:|^https?:\/\/\*\//.test(h)), JSON.stringify(mf.host_permissions));
  check("manifest: no tabs permission", !(mf.permissions || []).includes("tabs"));
  check("manifest: activeTab", (mf.permissions || []).includes("activeTab"));
  check("manifest: fonts use_dynamic_url", (mf.web_accessible_resources || []).every((w) => w.use_dynamic_url === true));
  const csp = (mf.content_security_policy || {}).extension_pages || "";
  check("manifest: CSP limits connect-src and blocks inline styles",
    /connect-src [^;]*localhost:8000/.test(csp) && /object-src 'none'/.test(csp) && !/unsafe-inline/.test(csp), csp);
  check("manifest: minimum_chrome_version", Number(mf.minimum_chrome_version) >= 116);
  check("manifest: no externally_connectable", !mf.externally_connectable);
}

// The real, unmodified extension: a site the user never allowed gets nothing.
async function testUngranted() {
  const b = await launch(EXT);
  try {
    const page = await b.ctx.newPage();
    await page.goto(`${FIX}/fingerprint.html`);
    await sleep(1200);
    const probe = await page.evaluate((id) => window.probe(id), b.id);
    check("ungranted: page sees nothing on <html> (no prefs leak)", !probe.style && !probe.className, JSON.stringify(probe));
    check("ungranted: static font URL can't be fetched (no install probe)", probe.fontFetch === "blocked", probe.fontFetch);

    const info = await b.sw.evaluate(() => handlers.TAB_INFO());
    check("ungranted: TAB_INFO reveals no url/title", !info.url && !info.title && info.access === false, JSON.stringify(info));
    let err = "";
    try { await b.sw.evaluate(() => analyzeActiveTab()); } catch (e) { err = e.message; }
    check("ungranted: analyze refused by Chrome", /Cannot access|permission/i.test(err), err.slice(0, 120));
    const state = await b.sw.evaluate(() => handlers.GET_PAGE_STATE());
    check("ungranted: GET_PAGE_STATE doesn't inject", state === null, JSON.stringify(state));
    const perms = await b.sw.evaluate(() => chrome.permissions.getAll());
    check("ungranted: only the backend origin is granted",
      JSON.stringify(perms.origins) === JSON.stringify(["http://localhost:8000/*"]), JSON.stringify(perms));
    let autoErr = "";
    try { await b.sw.evaluate(() => handlers.AUTO_APPLY({ on: true })); } catch (e) { autoErr = e.message; }
    check("ungranted: 'every website' needs the all-sites permission first", /access to all sites/.test(autoErr), autoErr.slice(0, 120));

    // The user clicks the Skimatic icon on a page: activeTab gives access to that tab only.
    const article = await b.ctx.newPage();
    await article.goto(ARTICLE);
    await article.bringToFront();
    const cdp = await b.ctx.browser().newBrowserCDPSession();
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const target = targetInfos.find((t) => t.url === ARTICLE);
    await cdp.send("Extensions.triggerAction", { id: b.id, targetId: target.targetId });
    await sleep(800);
    const clicked = await b.sw.evaluate(() => handlers.TAB_INFO());
    check("toolbar icon grants access to the clicked tab", clicked.access === true, JSON.stringify(clicked));
    const painted = await b.sw.evaluate(() => analyzeActiveTab()).catch((e) => ({ error: e.message }));
    check("...and Highlight works there", painted.found > 0, JSON.stringify(painted).slice(0, 120));
    await page.bringToFront();
    const other = await b.sw.evaluate(() => handlers.TAB_INFO());
    check("...but not on another tab", other.access === false, JSON.stringify(other));
    await article.close();

    // Extension pages: CSP blocks requests to other hosts.
    const panel = await b.ctx.newPage();
    await panel.goto(`chrome-extension://${b.id}/sidepanel/sidepanel.html`);
    await panel.waitForFunction(() => document.querySelector("#backend-status").dataset.state !== "checking", null, { timeout: 5000 }).catch(() => {});
    const status = await panel.evaluate(() => document.querySelector("#backend-status").dataset.state);
    check("panel talks to the background and backend (CSP allows it)", status === "mock" || status === "ok", status);
    const blocked = await panel.evaluate(async (fix) => {
      try { await fetch(fix + "/hit?v=panel-fetch"); return "fetched"; } catch (e) { return "blocked"; }
    }, FIX);
    check("panel CSP: fetch to another host is blocked", blocked === "blocked");
    // Forged key points never reach the list, and can't inject CSS.
    await panel.evaluate(() => emitPage("HIGHLIGHTS_STATE", {
      items: [
        { id: "1", role: "main) url(http://127.0.0.1:5600/hit?v=panel-css", text: "forged role" },
        { id: 'x"]', role: "main", text: "forged id" },
        { id: "2", role: "evidence", text: "A real-looking item" },
      ],
      hiddenRoles: ["main) url(x"],
    }));
    await sleep(500);
    const rows = await panel.evaluate(() => [...document.querySelectorAll("#kp-list .kp-text")].map((e) => e.textContent));
    check("panel: malformed key points are dropped", rows.length === 1 && rows[0] === "A real-looking item", JSON.stringify(rows));
    check("panel: no CSS url() request from a forged role", !hits.includes("panel-css"));
  } finally {
    await close(b);
  }
}

async function testGranted() {
  const dir = grantedCopy();
  const b = await launch(dir);
  try {
    // ---------- before the user does anything ----------
    const fp = await b.ctx.newPage();
    await fp.goto(`${FIX}/fingerprint.html`);
    await b.sw.evaluate(() => chrome.storage.sync.set({ colors: { main: "#a1b2c3" } }));
    await sleep(800);
    const probe = await fp.evaluate((id) => window.probe(id), b.id);
    check("granted site, not used: nothing written onto <html>", !probe.style && !probe.className, JSON.stringify(probe));
    await fp.close();

    // ---------- regression: highlight, simplify, key points, jump ----------
    const page = await b.ctx.newPage();
    await page.goto(ARTICLE);
    await page.bringToFront();
    const info = await b.sw.evaluate(() => handlers.TAB_INFO());
    check("TAB_INFO on an allowed site", info.access && /Octopuses/.test(info.title), JSON.stringify(info));
    const res = await b.sw.evaluate(() => analyzeActiveTab());
    check("analyze paints highlights", res.found > 0 && res.found === res.total, `found ${res.found}/${res.total}`);
    const color = await page.evaluate(() => document.documentElement.style.getPropertyValue("--scr-color-main"));
    check("custom color applied once highlighted", color.trim() === "#a1b2c3", color);

    const firstMark = page.locator("mark.scr-hl").first();
    await firstMark.click();
    await page.waitForSelector("mark.scr-hl .scr-core", { timeout: 5000 }).catch(() => {});
    check("real click simplifies (backbone shown)", (await page.locator("mark.scr-hl .scr-core").count()) > 0);
    await firstMark.click();
    await sleep(300);
    check("second click restores the sentence", (await page.locator("mark.scr-hl .scr-core").count()) === 0);
    await firstMark.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("mark.scr-hl .scr-core", { timeout: 5000 }).catch(() => {});
    check("Enter on a highlight simplifies", (await page.locator("mark.scr-hl .scr-core").count()) > 0);
    await page.keyboard.press("Enter");

    const state = await toTab(b.sw, { type: "GET_PAGE_STATE" });
    check("GET_PAGE_STATE lists the key points", state.highlights.items.length === res.found && state.progress && state.progress.keyTotal > 0,
      `${state.highlights.items.length} items`);
    const item = state.highlights.items[state.highlights.items.length - 1];
    const jump = await b.sw.evaluate((it) => handlers.JUMP_TO({ id: it.id, role: it.role, text: it.text, n: 1 }), item);
    check("JUMP_TO works", jump && jump.ok, JSON.stringify(jump));

    // ---------- reading comfort ----------
    await b.sw.evaluate(() => scrSaveReading({ enabled: true, font: "lexend", theme: "cream" }));
    await sleep(500);
    let html = await page.evaluate(() => ({ cls: document.documentElement.className, size: document.documentElement.style.getPropertyValue("--scr-size") }));
    check("text settings apply", /scr-read/.test(html.cls) && /scr-theme-cream/.test(html.cls) && html.size === "20px", JSON.stringify(html));
    const fontOk = await page.evaluate(async () => {
      await document.fonts.load('20px "SCR Lexend"');
      return document.fonts.check('20px "SCR Lexend"');
    });
    check("bundled font loads (web-accessible with use_dynamic_url)", fontOk);
    await b.sw.evaluate(() => scrSaveReading({ enabled: false, theme: "site", font: "site" }));
    await sleep(400);
    html = await page.evaluate(() => ({ cls: document.documentElement.className, size: document.documentElement.style.getPropertyValue("--scr-size") }));
    check("text settings off: their values are removed from <html>", !/scr-read/.test(html.cls) && html.size === "", JSON.stringify(html));
    await b.sw.evaluate(() => scrSaveReading({ focusMode: true }));
    await sleep(500);
    check("focus mode on", await page.evaluate(() => document.documentElement.classList.contains("scr-focus") && !!document.querySelector(".scr-active")));
    await b.sw.evaluate(() => scrSaveReading({ focusMode: false }));

    const open = await b.sw.evaluate(() => handlers.READER({ action: "open" }));
    const reader = await page.evaluate(() => {
      const r = document.getElementById("scr-reader");
      return r && { paras: r.querySelectorAll(".scr-reader-body p").length, marks: r.querySelectorAll("mark.scr-hl").length };
    });
    check("reading view opens with the article and highlights", open.ok && reader && reader.paras >= 4 && reader.marks > 0, JSON.stringify(reader));
    await b.sw.evaluate(() => handlers.READER({ action: "close" }));

    const speak = await b.sw.evaluate(() => handlers.SPEAK({ scope: "highlights", rate: 1 }));
    check("read aloud answers", speak && (speak.ok || /voice|browser/i.test(speak.error || "")), JSON.stringify(speak));
    await b.sw.evaluate(() => handlers.SPEECH_CONTROL({ action: "stop" }));

    // ---------- message passing: content-script world can't use panel-only messages ----------
    const probes = [{ type: "TAB_INFO" }, { type: "ANALYZE_ACTIVE_TAB" }, { type: "GET_PAGE_STATE" },
      { type: "READER", action: "open" }, { type: "HEALTH" }, { type: "AUTO_APPLY", on: true },
      { type: "JUMP_TO", id: "1" }, { type: "SIMPLIFY", sentence: "Attacker text " + Math.random() },
      { type: "SIMPLIFY", index: 999 }, { type: "__proto__" }, { type: "toString" }];
    const fromPage = await sendFromContentWorld(b.sw, probes);
    const leaked = fromPage.filter((v) => v && v.ok);
    check("content-script world gets no panel-only answers", fromPage.length === probes.length && leaked.length === 0,
      JSON.stringify(fromPage).slice(0, 300));
    check("reader not opened by a content-script message", !(await page.evaluate(() => !!document.getElementById("scr-reader"))));
    const [okSimplify] = await sendFromContentWorld(b.sw, [{ type: "SIMPLIFY", index: 0 }]);
    check("SIMPLIFY by index of a real highlight works", okSimplify && okSimplify.ok && Array.isArray(okSimplify.data.core), JSON.stringify(okSimplify));

    // ---------- forged marks ----------
    const evil = await b.ctx.newPage();
    await evil.goto(`${FIX}/forged-marks.html`);
    await evil.bringToFront();
    const r2 = await b.sw.evaluate(() => analyzeActiveTab());
    const before = await b.sw.evaluate(() => handlers.HEALTH()); // keeps the SW warm
    await evil.evaluate(() => window.forge(30));
    await sleep(1500);
    const forged = await evil.evaluate(() => ({
      simplifiedForged: document.querySelectorAll("#ugc mark .scr-core, #ugc mark.scr-loading").length,
      simplifiedReal: document.querySelectorAll("article mark .scr-core").length,
    }));
    check("page-made clicks don't simplify (forged or real marks)", forged.simplifiedForged === 0 && forged.simplifiedReal === 0, JSON.stringify(forged));
    const st = await toTab(b.sw, { type: "GET_PAGE_STATE" });
    const texts = st.highlights.items.map((i) => i.text);
    check("forged marks are not key points", st.highlights.items.length === r2.found && !texts.some((t) => /SCAM/.test(t)),
      `${st.highlights.items.length} items, found ${r2.found}`);
    const it2 = st.highlights.items[0];
    const j2 = await b.sw.evaluate((it) => handlers.JUMP_TO({ id: it.id, role: it.role, text: it.text, n: 1 }), it2);
    check("JUMP_TO still works next to forged ids", j2 && j2.ok, JSON.stringify(j2));
    check("no request from the forged role", !hits.includes("forged-role"));
    void before;

    // ---------- reading view sanitizer ----------
    const xss = await b.ctx.newPage();
    const logs = [];
    xss.on("console", (m) => logs.push(m.text()));
    await xss.goto(`${FIX}/reader-xss.html`);
    await xss.bringToFront();
    await sleep(500);
    const hitsBefore = hits.length;
    const ro = await b.sw.evaluate(() => handlers.READER({ action: "open" }));
    await sleep(2000);
    const fired = logs.filter((l) => l.startsWith("HIT") && /reader=true/.test(l)).concat(hits.slice(hitsBefore));
    check("reader opens on the hostile page", ro && ro.ok, JSON.stringify(ro));
    check("no handler runs inside the reading view", fired.length === 0, JSON.stringify(fired));
    const body = await xss.evaluate(() => {
      const b = document.querySelector("#scr-reader .scr-reader-body");
      const attrs = [...b.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.name));
      return {
        paras: b.querySelectorAll("p").length,
        safeLink: !!b.querySelector('a[href="https://example.com/safe"]'),
        hrefs: [...b.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
        onAttrs: attrs.filter((n) => n.startsWith("on")),
        bad: b.querySelectorAll("svg, input, x-widget, script, details").length,
        custom: /custom element text/.test(b.textContent),
      };
    });
    check("reader keeps the article text and safe links", body.paras >= 6 && body.safeLink && body.custom, JSON.stringify(body));
    check("reader drops script links, on* attributes and unsafe elements",
      body.hrefs.every((h) => /^https?:/.test(h)) && body.onAttrs.length === 0 && body.bad === 0, JSON.stringify(body));
  } finally {
    await close(b);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// "Use on every website": with all-sites access granted (standing in for the user saying
// yes to Chrome's prompt), reading settings follow the reader to a new page; off again stops it.
async function testAutoApply() {
  const dir = grantedCopy(["http://*/*", "https://*/*"]);
  const b = await launch(dir);
  try {
    await b.sw.evaluate(() => scrSaveReading({ enabled: true, theme: "cream" }));
    const on = await b.sw.evaluate(() => handlers.AUTO_APPLY({ on: true }));
    const page = await b.ctx.newPage();
    await page.goto(ARTICLE);
    await page.waitForFunction(() => document.documentElement.classList.contains("scr-read"), null, { timeout: 5000 }).catch(() => {});
    check("every website on: settings apply on a new page by themselves", on.on &&
      await page.evaluate(() => document.documentElement.classList.contains("scr-read")));
    const off = await b.sw.evaluate(() => handlers.AUTO_APPLY({ on: false }));
    const page2 = await b.ctx.newPage();
    await page2.goto(`${FIX}/fingerprint.html`);
    await sleep(1200);
    check("every website off: new pages are left alone", !off.on &&
      !(await page2.evaluate(() => document.documentElement.className)));
  } finally {
    await close(b);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The side panel in preview mode (dev-stub.js) still works under the new code.
async function testPreview() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:5500/__ext/sidepanel/sidepanel.html");
    await page.click("#analyze");
    await page.waitForFunction(() => document.querySelectorAll("#kp-list li").length > 0, null, { timeout: 5000 }).catch(() => {});
    const n = await page.locator("#kp-list li").count();
    check("preview: Highlight fills the key points list", n > 0, `${n} items`);
    await page.click('[aria-controls="comfort-body"]'); // Reading comfort starts collapsed
    await page.click("#auto-apply");
    await sleep(200);
    check("preview: 'Use on every website' switch toggles",
      (await page.getAttribute("#auto-apply", "aria-checked")) === "true");
    check("preview: no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
}

(async () => {
  try {
    const h = await fetch(BACKEND + "/health").then((r) => r.json());
    if (!h.mock) console.log("note: backend is not in mock mode (MOCK_LLM=1 recommended)");
  } catch (e) {
    console.error(`Backend not reachable at ${BACKEND}. Start it with MOCK_LLM=1 (see the top of this file).`);
    process.exit(2);
  }
  // /__ext/ serves the extension folder, for the panel's preview mode.
  const s1 = await serve(path.join(ROOT, "testing"), 5500, "localhost", { "/__ext/": EXT });
  const s2 = await serve(path.join(__dirname, "pages"), 5600, "127.0.0.1");
  try {
    await testManifest();
    await testUngranted();
    await testGranted();
    await testAutoApply();
    await testPreview();
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    s1.close();
    s2.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})();
