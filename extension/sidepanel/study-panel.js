// "Study" card: questions to think about before reading (pre-questions), and a short
// multiple-choice quiz after reading (retrieval practice). Both come from ONE call to
// the backend (/study, via background.js STUDY), which background.js keeps per tab, so
// reopening the panel or coming back to the tab costs no new AI call.
// Calm on purpose: no timers, streaks or confetti. See docs/ACCESSIBILITY.md, "Study".
// Uses helpers from sidepanel.js ($, send, setBusy, isBusy, friendlyError, NO_ACCESS).
// Everything from the AI is shown with textContent, never as HTML.

(function () {
  const getBtn = $("study-get");
  const quizBtn = $("quiz-start");
  const statusEl = $("study-status");
  const preBody = $("pre-body");
  const preList = $("pre-list");
  const whereToggle = $("pre-where");
  const preToggle = $("pre-toggle");
  const quizEl = $("quiz");
  const countEl = $("quiz-count");
  const questionEl = $("quiz-question");
  const optionsEl = $("quiz-options");
  const feedbackEl = $("quiz-feedback");
  const verdictEl = $("quiz-verdict");
  const explainEl = $("quiz-explain");
  const quizWhere = $("quiz-where");
  const checkBtn = $("quiz-check");
  const nextBtn = $("quiz-next");
  const resultEl = $("quiz-result");
  const scoreEl = $("quiz-score");
  const messageEl = $("quiz-message");
  const reviewBtn = $("quiz-review");
  const againBtn = $("quiz-again");
  const liveEl = $("quiz-live");

  const LETTERS = ["A", "B", "C", "D"];

  let data = null;   // {title, prequestions, quiz} for the page shown, or null
  let dataSig = "";  // identifies `data`, to keep quiz progress per page
  // Quiz progress per page (this panel session only), so switching tabs and back
  // keeps your place.
  const progressBySig = new Map();
  // Bumped whenever the panel switches to another tab or page. A STUDY reply that
  // comes back after that belongs to the old tab and is dropped (background.js has
  // kept it for that tab, so going back shows it without a new AI call).
  let generation = 0;
  // The "Before you read" questions fold to one line while the quiz is on screen,
  // so the quiz isn't pushed below the fold.
  let preCollapsed = false;
  let quiz = null;   // {items, at, answers: [index|null], checked, mode: "quiz"|"review"|"done", missed, reviewAt}

  function setStudyStatus(text, kind = "") {
    if (statusEl.textContent !== text) statusEl.textContent = text;
    statusEl.className = "status study-status" + (kind ? " " + kind : "");
  }

  // Short, polite announcements for screen readers. Emptied first so the same
  // words are read again.
  function say(text) {
    liveEl.textContent = "";
    setTimeout(() => { liveEl.textContent = text; }, 50);
  }

  // ---------- Getting the questions (one AI call) ----------
  async function loadStudy(btn, busyLabel) {
    if (data) return true;
    if (isBusy(getBtn) || isBusy(quizBtn)) return false;
    const label = btn.querySelector(".btn-label");
    const idle = label.textContent;
    [getBtn, quizBtn].forEach((b) => setBusy(b, true));
    btn.classList.add("loading");
    label.textContent = busyLabel;
    setStudyStatus("Reading the article and writing questions…");
    const asked = generation;

    const info = await send({ type: "TAB_INFO" });
    const res = info.ok && info.data && info.data.access === false
      ? (send({ type: "REQUEST_ACCESS" }), { ok: false, error: NO_ACCESS })
      : await send({ type: "STUDY" });

    [getBtn, quizBtn].forEach((b) => setBusy(b, false));
    btn.classList.remove("loading");
    label.textContent = idle;
    if (asked !== generation) return false; // the reader moved to another tab meanwhile
    if (!res.ok || !res.data) {
      setStudyStatus(friendlyError(res.error || "The AI didn't answer properly. Try again."), "error");
      return false;
    }
    setStudyStatus("");
    useData(res.data);
    return true;
  }

  // Only well-formed items, capped (the background checked them already; the panel
  // still never trusts shapes it renders).
  function cleanData(d) {
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const prequestions = (Array.isArray(d && d.prequestions) ? d.prequestions : [])
      .map((q) => ({ question: str(q && q.question, 200), paragraph_id: q && q.paragraph_id }))
      .filter((q) => q.question && Number.isInteger(q.paragraph_id)).slice(0, 3);
    const items = (Array.isArray(d && d.quiz) ? d.quiz : [])
      .map((q) => ({
        question: str(q && q.question, 200),
        options: Array.isArray(q && q.options) ? q.options.map((o) => str(o, 120)) : [],
        answer: q && q.answer,
        explanation: str(q && q.explanation, 200),
        paragraph_id: q && q.paragraph_id,
      }))
      .filter((q) => q.question && q.options.length === 4 && q.options.every(Boolean) &&
        Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4 && Number.isInteger(q.paragraph_id))
      .slice(0, 5);
    return { prequestions, quiz: items };
  }

  function useData(raw) {
    const clean = cleanData(raw);
    const sig = JSON.stringify(clean);
    if (sig === dataSig) return; // same page, same questions: keep where the reader is
    if (quiz && dataSig) progressBySig.set(dataSig, quiz);
    data = clean;
    dataSig = sig;
    getBtn.hidden = true; // the questions are here now (also after reopening the panel)
    quiz = progressBySig.get(sig) || null;
    preCollapsed = !!quiz; // back on a page whose quiz was started: keep the questions folded
    renderPre();
    renderQuiz();
  }

  function clearData() {
    if (quiz && dataSig) progressBySig.set(dataSig, quiz);
    data = null;
    dataSig = "";
    quiz = null;
    preCollapsed = false;
    renderPre();
    getBtn.hidden = false;
    quizBtn.hidden = false;
    renderQuiz();
  }

  // The panel opened, or the reader switched tabs / the page changed: show what that
  // tab already has (never calls the AI).
  self.scrStudyRefresh = async function () {
    const asked = ++generation;
    const res = await send({ type: "STUDY", cachedOnly: true });
    if (asked !== generation) return; // an even newer tab/page took over
    setStudyStatus("");
    if (res.ok && res.data) useData(res.data);
    else clearData();
  };

  // ---------- Before you read ----------
  function renderPre() {
    const n = data ? data.prequestions.length : 0;
    preToggle.hidden = !n || !preCollapsed;
    preToggle.textContent = `Show the ${n === 1 ? "question" : n + " questions"}`;
    preToggle.setAttribute("aria-expanded", "false");
    preBody.hidden = !n || preCollapsed;
    preList.textContent = "";
    (data ? data.prequestions : []).forEach((q, i) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.className = "pre-q";
      text.textContent = q.question;
      const where = document.createElement("button");
      where.type = "button";
      where.className = "text-btn where-btn";
      where.textContent = "Where?";
      // The visible word comes first in the name (WCAG 2.5.3), then which question.
      where.setAttribute("aria-label", `Where? Question ${i + 1}`);
      where.addEventListener("click", () => jump(q.paragraph_id));
      li.append(text, where);
      preList.append(li);
    });
  }

  getBtn.addEventListener("click", async () => {
    if (!(await loadStudy(getBtn, "Writing questions…"))) return;
    if (!data.prequestions.length) {
      getBtn.hidden = false;
      setStudyStatus("No questions for this article. Try the quiz after reading.");
      return;
    }
    // The button the reader pressed is gone; land on what replaced it.
    (preCollapsed ? preToggle : $("pre-intro")).focus();
  });

  // Folded during the quiz; one click shows the questions again.
  preToggle.addEventListener("click", () => {
    const show = preToggle.getAttribute("aria-expanded") !== "true";
    preToggle.setAttribute("aria-expanded", String(show));
    const n = data.prequestions.length;
    preToggle.textContent = show ? "Hide the questions" : `Show the ${n === 1 ? "question" : n + " questions"}`;
    preBody.hidden = !show;
  });

  // "Where?" is hidden at first, so readers try to answer from memory before looking.
  whereToggle.addEventListener("click", () => {
    const show = whereToggle.getAttribute("aria-expanded") !== "true";
    whereToggle.setAttribute("aria-expanded", String(show));
    whereToggle.textContent = show ? "Hide where" : "Show where";
    preList.classList.toggle("show-where", show);
  });

  const NOT_ON_PAGE = "That part of the article isn't on the page.";
  async function jump(paragraphId) {
    const res = await send({ type: "JUMP_TO_PARAGRAPH", paragraph_id: paragraphId });
    const reply = res.ok ? res.data : null; // null: Skimatic isn't running on this page (any more)
    if (reply && reply.ok) return setStudyStatus("");
    setStudyStatus(res.ok ? NOT_ON_PAGE : friendlyError(res.error), "error");
  }

  // ---------- After you read: the quiz ----------
  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // "Try again" mixes the questions and their options locally (no new AI call).
  function reshuffled(items) {
    return shuffle(items).map((q) => {
      const order = shuffle([0, 1, 2, 3]);
      return { ...q, options: order.map((k) => q.options[k]), answer: order.indexOf(q.answer) };
    });
  }

  function newQuiz(items) {
    return { items, at: 0, answers: items.map(() => null), checked: false, mode: "quiz", missed: [], reviewAt: 0 };
  }

  quizBtn.addEventListener("click", async () => {
    if (!(await loadStudy(quizBtn, "Writing the quiz…"))) return;
    if (!quiz) quiz = newQuiz(data.quiz);
    preCollapsed = true; // done with "Before you read": fold it so the quiz starts near the top
    renderPre();
    renderQuiz();
    countEl.focus();
  });

  function current() {
    if (quiz.mode === "review") return quiz.missed[quiz.reviewAt];
    return quiz.at;
  }

  function renderQuiz() {
    const active = !!(quiz && data);
    quizBtn.hidden = active;
    quizEl.hidden = !active || quiz.mode === "done";
    resultEl.hidden = !active || quiz.mode !== "done";
    if (!active) return;
    if (quiz.mode === "done") return renderResult();

    const i = current();
    const item = quiz.items[i];
    const review = quiz.mode === "review";
    const checked = review || quiz.checked;
    countEl.textContent = review
      ? `Missed question ${quiz.reviewAt + 1} of ${quiz.missed.length}`
      : `Question ${i + 1} of ${quiz.items.length}`;
    questionEl.textContent = item.question;

    optionsEl.textContent = "";
    item.options.forEach((opt, k) => {
      const label = document.createElement("label");
      label.className = "option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "quiz-option";
      input.value = String(k);
      input.checked = quiz.answers[i] === k;
      input.disabled = checked; // the answer is in: read-only
      input.addEventListener("change", () => {
        quiz.answers[i] = k;
        setStudyStatus("");
      });
      const letter = document.createElement("span");
      letter.className = "opt-letter";
      letter.textContent = LETTERS[k];
      const text = document.createElement("span");
      text.className = "opt-text";
      text.textContent = opt;
      label.append(input, letter, text);
      if (checked) {
        // Right / wrong is shown with color AND words (and a mark), never color alone.
        const mark = document.createElement("span");
        mark.className = "opt-mark";
        if (k === item.answer) {
          label.classList.add("is-correct");
          mark.textContent = "✓ Correct answer";
        } else if (quiz.answers[i] === k) {
          label.classList.add("is-wrong");
          mark.textContent = "✗ Your answer";
        }
        if (mark.textContent) label.append(mark);
      }
      optionsEl.append(label);
    });

    feedbackEl.hidden = !checked;
    if (checked) {
      const right = quiz.answers[i] === item.answer;
      verdictEl.textContent = right ? "Correct." : `Not quite. The answer is “${item.options[item.answer]}”.`;
      verdictEl.className = "verdict " + (right ? "is-correct" : "is-wrong");
      explainEl.textContent = item.explanation;
      explainEl.hidden = !item.explanation;
    }
    checkBtn.hidden = checked;
    nextBtn.hidden = !checked;
    nextBtn.textContent = review
      ? (quiz.reviewAt + 1 < quiz.missed.length ? "Next missed" : "Back to score")
      : (i + 1 < quiz.items.length ? "Next" : "See score");
  }

  checkBtn.addEventListener("click", () => {
    const i = quiz.at;
    if (quiz.answers[i] == null) {
      setStudyStatus("Pick an answer first.");
      return;
    }
    quiz.checked = true;
    renderQuiz();
    const item = quiz.items[i];
    const right = quiz.answers[i] === item.answer;
    say(right
      ? `Correct. ${item.explanation}`
      : `Not quite. The answer is “${item.options[item.answer]}”. ${item.explanation}`);
    nextBtn.focus(); // Check was replaced by Next, in the same place
  });

  nextBtn.addEventListener("click", () => {
    if (quiz.mode === "review") {
      if (quiz.reviewAt + 1 < quiz.missed.length) {
        quiz.reviewAt += 1;
        renderQuiz();
        jump(quiz.items[current()].paragraph_id);
        countEl.focus();
      } else {
        quiz.mode = "done";
        renderQuiz();
        scoreEl.focus();
      }
      return;
    }
    if (quiz.at + 1 < quiz.items.length) {
      quiz.at += 1;
      quiz.checked = false;
      renderQuiz();
      countEl.focus();
    } else {
      quiz.mode = "done";
      quiz.missed = quiz.items.map((q, k) => k).filter((k) => quiz.answers[k] !== quiz.items[k].answer);
      renderQuiz();
      scoreEl.focus();
    }
  });

  quizWhere.addEventListener("click", () => jump(quiz.items[current()].paragraph_id));

  // One calm line, no fireworks.
  function message(right, total) {
    if (right === total) return "You remembered all of it.";
    if (right >= total - 1) return "Nearly all of it stuck. Have a look at the one you missed.";
    if (right * 2 >= total) return "A good start. The ones you missed are worth a second look.";
    return "Worth another pass. Review the ones you missed, then try again.";
  }

  function renderResult() {
    const total = quiz.items.length;
    const right = total - quiz.missed.length;
    scoreEl.textContent = `${right} of ${total}`;
    messageEl.textContent = message(right, total);
    reviewBtn.hidden = !quiz.missed.length;
  }

  // Go through the missed questions: each one shows the right answer and its
  // explanation, and the page scrolls to where the article answers it.
  reviewBtn.addEventListener("click", () => {
    if (!quiz.missed.length) return;
    quiz.mode = "review";
    quiz.reviewAt = 0;
    renderQuiz();
    jump(quiz.items[current()].paragraph_id);
    countEl.focus();
  });

  againBtn.addEventListener("click", () => {
    quiz = newQuiz(reshuffled(data.quiz));
    preCollapsed = false; // a fresh round: the pre-questions are worth another look
    renderPre();
    renderQuiz();
    countEl.focus();
  });

  self.scrStudyRefresh();
})();
