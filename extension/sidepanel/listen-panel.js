// "Listen" card: read aloud controls. The page does the speaking (speech.js); the panel
// sends SPEAK / SPEECH_CONTROL and follows SPEECH_STATE. Voices come from chrome.tts, the
// engine background.js speaks with, filtered and ranked by shared/voices.js (no novelty
// voices, the reader's language, best first). Uses helpers from sidepanel.js and
// reading-panel.js (scrReading / scrReadingChange).

(function () {
  const play = $("speech-play");
  const stop = $("speech-stop");
  const prev = $("speech-prev");
  const next = $("speech-next");
  const statusEl = $("speech-status");
  const rate = $("speechRate");
  const voiceSelect = $("voice");

  let speech = { state: "stopped", index: 0, total: 0, text: "" };
  let errorText = "";
  let stateCount = 0; // how many SPEECH_STATE messages have arrived (see the play button)

  function renderSpeech() {
    const s = speech.state;
    play.dataset.state = s;
    play.setAttribute("aria-label", s === "playing" ? "Pause reading" : s === "paused" ? "Resume reading" : "Read aloud");
    const idle = s === "stopped";
    [stop, prev, next].forEach((b) => b.setAttribute("aria-disabled", String(idle)));
    statusEl.classList.toggle("error", !!errorText);
    if (errorText) statusEl.textContent = errorText;
    else if (s === "playing") statusEl.textContent = `Reading sentence ${speech.index + 1} of ${speech.total}`;
    else if (s === "paused") statusEl.textContent = `Paused at sentence ${speech.index + 1} of ${speech.total}`;
    else statusEl.textContent = "Not reading.";
  }

  onPageMessage("SPEECH_STATE", (m) => {
    if (!m) return;
    stateCount++;
    speech = { state: m.state || "stopped", index: m.index || 0, total: m.total || 0, text: m.text || "" };
    // The page says why reading stopped on its own (e.g. the browser blocked the voice).
    // A tab change (syncPageState) starts over: an old error belongs to the other page.
    if (m.error) errorText = String(m.error);
    else if (speech.state !== "stopped" || m.fromSync) errorText = "";
    renderSpeech();
  });

  function speechError(err) {
    if (/No highlights/i.test(err || "")) return "No highlights yet. Highlight the article first, or choose “Whole article”.";
    if (/Highlights are switched off/i.test(err || "")) return "Highlights are switched off. Turn on “Show highlights on the page”, or choose “Whole article”.";
    if (/Highlights are hidden/i.test(err || "")) return "All highlight types are hidden. Show one with its eye button or “Highlights to show”, or choose “Whole article”.";
    return friendlyError(err);
  }

  play.addEventListener("click", async () => {
    if (isBusy(play)) return;
    errorText = "";
    setBusy(play, true);
    const r = scrReading();
    let res;
    if (speech.state === "playing") res = await pageCall({ type: "SPEECH_CONTROL", action: "pause" });
    else if (speech.state === "paused") res = await pageCall({ type: "SPEECH_CONTROL", action: "resume" });
    else {
      const before = stateCount;
      res = await pageCall({ type: "SPEAK", scope: r.speechScope, rate: r.speechRate, voice: r.speechVoice });
      // The page's own SPEECH_STATE messages usually arrive before this reply (one hop
      // instead of two) and may already say "stopped" again. Only fill in "playing"
      // when none has arrived yet; otherwise the page's word is final.
      if (res.ok && stateCount === before) speech = { ...speech, state: "playing", index: 0, total: res.total || 0 };
    }
    setBusy(play, false);
    if (!res.ok) errorText = speechError(res.error);
    renderSpeech();
  });

  function control(btn, action) {
    btn.addEventListener("click", async () => {
      if (btn.getAttribute("aria-disabled") === "true") return;
      const res = await pageCall({ type: "SPEECH_CONTROL", action });
      if (!res.ok) { errorText = speechError(res.error); renderSpeech(); }
    });
  }
  control(stop, "stop");
  control(prev, "prev");
  control(next, "next");

  // ---------- Settings (stored with the reading settings) ----------
  // Switching between "Highlighted sentences" and "Whole article" takes effect at
  // once. Before, a paused or playing reading kept its old list, so ▶ went on
  // reading the highlights after "Whole article" was picked (or the other way round).
  document.querySelectorAll('input[name="scope"]').forEach((input) =>
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      scrReadingChange({ speechScope: input.value }, { immediate: true });
      if (speech.state === "stopped") return;
      const wasPlaying = speech.state === "playing";
      await pageCall({ type: "SPEECH_CONTROL", action: "stop" });
      speech = { ...speech, state: "stopped" };
      if (wasPlaying) {
        // Start the new list right away; the scope is passed directly so it
        // doesn't depend on the settings write finishing first.
        const r = scrReading();
        const res = await pageCall({ type: "SPEAK", scope: input.value, rate: r.speechRate, voice: r.speechVoice });
        if (!res.ok) errorText = speechError(res.error);
      }
      renderSpeech();
    })
  );
  rate.addEventListener("input", () => scrReadingChange({ speechRate: Math.round(+rate.value * 10) / 10 }));
  voiceSelect.addEventListener("change", () => scrReadingChange({ speechVoice: voiceSelect.value }, { immediate: true }));

  // Called by sidepanel.js when the reason for an earlier error may be gone (the page
  // was highlighted again, or highlights were switched back on).
  self.scrClearSpeechError = function () {
    if (!errorText) return;
    errorText = "";
    renderSpeech();
  };

  self.scrRenderListenSettings = function (r) {
    document.querySelectorAll('input[name="scope"]').forEach((i) => (i.checked = i.value === r.speechScope));
    if (+rate.value !== +r.speechRate) rate.value = r.speechRate;
    $("speechRate-out").textContent = `${(+r.speechRate).toFixed(1)}×`;
    rate.setAttribute("aria-valuetext", `${(+r.speechRate).toFixed(1)} times normal speed`);
    fillVoices(r.speechVoice);
  };

  // ---------- Voices ----------
  // Value "" = "Auto (best available)": background.js picks the best voice with the
  // same ranking each time it speaks, so a newly installed Premium voice is used at once.
  const uiLang = navigator.language || "en-US";
  let voices = [];   // ranked, at most 6
  let voiceKey = "";

  function loadVoices() {
    if (!chrome.tts || !chrome.tts.getVoices) return;
    chrome.tts.getVoices((all) => {
      voices = SCR_VOICES.rankVoices(all || [], uiLang, SCR_VOICES.OFFER_MAX);
      fillVoices(scrReading().speechVoice);
      showVoiceHint(all || []);
    });
  }

  // The "download a Premium voice" tip only helps on a Mac that has none yet; anywhere
  // else it's just more text, so it stays hidden (and out of the select's description).
  function showVoiceHint(all) {
    const hint = $("voice-hint");
    const show = /Mac/.test(navigator.userAgent) && !all.some(SCR_VOICES.isHighQuality);
    hint.hidden = !show;
    if (show) voiceSelect.setAttribute("aria-describedby", "voice-hint");
    else voiceSelect.removeAttribute("aria-describedby");
  }

  function fillVoices(selected) {
    const key = voices.map((v) => v.voiceName).join("|") + "#" + selected;
    if (key === voiceKey) return;
    voiceKey = key;
    voiceSelect.textContent = "";
    const best = voices[0];
    const auto = new Option(best ? `Auto · ${best.voiceName}` : "Auto (best available)", "");
    auto.title = "Auto picks the best voice installed on this computer.";
    voiceSelect.append(auto);
    for (const v of voices) voiceSelect.append(new Option(SCR_VOICES.voiceLabel(v, uiLang), v.voiceName));
    // A saved voice we don't offer (not installed here, novelty, other language, or
    // below the top 6) plays as Auto: background.js uses the same SCR_VOICES.resolve.
    voiceSelect.value = voices.some((v) => v.voiceName === selected) ? selected : "";
  }

  loadVoices();
  // Chrome can fill its voice list a moment after start-up, and voices can be
  // installed while the panel is open: look again when the reader comes back.
  setTimeout(loadVoices, 1500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadVoices(); });
  voiceSelect.addEventListener("focus", loadVoices);

  self.scrRenderListenSettings(scrReading());
  renderSpeech();
})();
