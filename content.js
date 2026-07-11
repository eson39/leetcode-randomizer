const SESSION_STORAGE_KEY = "activeSession";
const SETTINGS_STORAGE_KEY = "settings";
const ACCEPTED_TEXT = "Accepted";
const CHECK_INTERVAL_MS = 1200;
const SUBMISSION_TIMEOUT_MS = 25000;
const RESET_WAIT_TIMEOUT_MS = 15000;
const RESET_CONFIRM_DELAY_MS = 300;
const URL_WATCH_INTERVAL_MS = 500;
const RESET_ICON_PATHS = [
  "M5.725 9.255h2.843a1 1 0 110 2H3.2a1 1 0 01-1-1V4.887a1 1 0 012 0v3.056l2.445-2.297a9.053 9.053 0 11-2.142 9.415 1 1 0 011.886-.665 7.053 7.053 0 1010.064-8.515 7.063 7.063 0 00-8.417 1.202L5.725 9.255z",
  "M40 224c-13.3 0-24-10.7-24-24V56c0-13.3 10.7-24 24-24s24 10.7 24 24v80.1l20-23.5C125 63.4 186.9 32 256 32c123.7 0 224 100.3 224 224s-100.3 224-224 224c-50.4 0-97-16.7-134.4-44.8c-10.6-8-12.7-23-4.8-33.6s23-12.7 33.6-4.8C179.8 418.9 216.3 432 256 432c97.2 0 176-78.8 176-176s-78.8-176-176-176c-54.3 0-102.9 24.6-135.2 63.4l-.1 .2 0 0L93.1 176H184c13.3 0 24 10.7 24 24s-10.7 24-24 24H40z"
];
const RESET_CONFIRM_MESSAGE =
  "Your current code will be discarded and reset to the default code!";
const TIMER_INTERVAL_MS = 1000;
const TOGGLE_SHORTCUT_LABEL = "Alt+Shift+H";
const SUBMIT_LOCATOR_TEXTS = ["console-submit-button", "submit"];
const RESULT_CONTAINER_SELECTORS = [
  '[data-e2e-locator="submission-result"]',
  '[data-e2e-locator="console-result"]',
  '[data-e2e-locator="result-panel"]',
  '[data-e2e-locator="submission-result-panel"]',
  '[data-layout-path="/ts0/t0"]'
];
const FAILURE_TEXTS = [
  "Wrong Answer",
  "Runtime Error",
  "Time Limit Exceeded",
  "Compile Error",
  "Memory Limit Exceeded",
  "Output Limit Exceeded",
  "Presentation Error"
];

let activeSession = null;
let sidebarPrefs = { expanded: false };
let waitingForSubmissionResult = false;
let submissionStartedAt = 0;
let lastReportedSessionItem = null;
let mutationObserver = null;
let checkIntervalId = null;
let timerIntervalId = null;
let resetPollId = null;
let urlWatchId = null;
let lastObservedSlug = null;
let lastAutoResetSlug = null;
let overlayMessage = "";
let actionPending = false;
let sidebarHost = null;
let acceptedPromptHost = null;
let headerTimerHost = null;
let celebrationHost = null;
let celebrationSessionId = null;

document.addEventListener("click", handleDocumentClick, true);
document.addEventListener("keydown", handleKeydown, true);
chrome.storage.onChanged.addListener(handleStorageChange);
void initialize();

async function initialize() {
  const stored = await chrome.storage.local.get([
    SESSION_STORAGE_KEY,
    SETTINGS_STORAGE_KEY
  ]);
  activeSession = stored[SESSION_STORAGE_KEY] || null;
  sidebarPrefs = normalizeSidebarPrefs(
    stored[SETTINGS_STORAGE_KEY]?.sidebarPrefs ||
      stored[SETTINGS_STORAGE_KEY]?.overlayPrefs
  );

  renderSessionSidebar();
  renderHeaderTimer();
  syncTimerState();
  if (isSessionComplete(activeSession)) {
    showCelebrationScreen();
  }
  startWatching();

  lastObservedSlug = getProblemSlug();
  void maybeScheduleEditorReset();
}

function normalizeSidebarPrefs(prefs = {}) {
  if (prefs.expanded != null) {
    return { expanded: Boolean(prefs.expanded) };
  }

  if (prefs.visible != null) {
    return { expanded: Boolean(prefs.visible) };
  }

  return { expanded: false };
}

function startWatching() {
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
  }

  checkIntervalId = window.setInterval(
    checkForAcceptedSubmission,
    CHECK_INTERVAL_MS
  );

  if (mutationObserver) {
    mutationObserver.disconnect();
  }

  mutationObserver = new MutationObserver(() => {
    if (waitingForSubmissionResult) {
      void checkForAcceptedSubmission();
    }
  });
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  startUrlWatching();
}

function startUrlWatching() {
  if (urlWatchId) {
    clearInterval(urlWatchId);
  }

  urlWatchId = window.setInterval(() => {
    const slug = getProblemSlug();
    if (!slug || slug === lastObservedSlug) {
      return;
    }

    lastObservedSlug = slug;
    void maybeScheduleEditorReset();
  }, URL_WATCH_INTERVAL_MS);
}

function startTimerUpdates() {
  if (timerIntervalId || isSessionComplete()) {
    return;
  }

  timerIntervalId = window.setInterval(updateTimerDisplay, TIMER_INTERVAL_MS);
}

function stopTimerUpdates() {
  if (!timerIntervalId) {
    return;
  }

  clearInterval(timerIntervalId);
  timerIntervalId = null;
}

function syncTimerState() {
  if (!activeSession) {
    stopTimerUpdates();
    removeHeaderTimer();
    updateTimerDisplay();
    return;
  }

  renderHeaderTimer();

  if (isSessionComplete(activeSession) || isSessionPaused(activeSession)) {
    stopTimerUpdates();
    updateTimerDisplay();
    return;
  }

  startTimerUpdates();
}

function isSessionComplete(session = activeSession) {
  if (!session) {
    return false;
  }

  return session.currentIndex >= session.queue.length;
}

function isSessionPaused(session = activeSession) {
  return Boolean(session?.isPaused);
}

function handleKeydown(event) {
  if (!event.altKey || !event.shiftKey || event.key.toLowerCase() !== "h") {
    return;
  }

  if (!activeSession) {
    return;
  }

  event.preventDefault();
  toggleSidebarExpanded();
}

function handleDocumentClick(event) {
  const actionElement = event.target.closest("button, [role=\"button\"]");
  if (!actionElement || !isSubmitAction(actionElement)) {
    return;
  }

  if (!isCurrentQueuedPage()) {
    return;
  }

  waitingForSubmissionResult = true;
  submissionStartedAt = Date.now();
  overlayMessage = "Checking submission result…";
  renderSessionSidebar();
  renderHeaderTimer();
  syncTimerState();
}

async function checkForAcceptedSubmission() {
  if (!waitingForSubmissionResult || !isCurrentQueuedPage()) {
    return;
  }

  if (Date.now() - submissionStartedAt > SUBMISSION_TIMEOUT_MS) {
    waitingForSubmissionResult = false;
    overlayMessage = "Result detection timed out. Submit again to retry.";
    renderSessionSidebar();
    return;
  }

  const resultText = getSubmissionResultText();
  if (!resultText) {
    return;
  }

  if (hasFailureResult(resultText)) {
    waitingForSubmissionResult = false;
    overlayMessage = "Not accepted yet. Keep going.";
    renderSessionSidebar();
    return;
  }

  if (!resultText.includes(ACCEPTED_TEXT)) {
    return;
  }

  const currentProblem = getCurrentProblem();
  const reportKey = `${activeSession.id}:${currentProblem.slug}`;
  if (lastReportedSessionItem === reportKey) {
    waitingForSubmissionResult = false;
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "LEETCODE_PROBLEM_ACCEPTED",
      slug: currentProblem.slug,
      sessionId: activeSession.id
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not record the accepted result.");
    }

    lastReportedSessionItem = reportKey;
    waitingForSubmissionResult = false;
    overlayMessage = "Accepted — Next is now unlocked.";
    showAcceptedPrompt(currentProblem.slug, activeSession.id);
  } catch (error) {
    console.error("Failed to report accepted problem:", error);
    overlayMessage = error.message;
  }

  renderSessionSidebar();
  renderHeaderTimer();
  syncTimerState();
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local") {
    return;
  }

  if (changes[SETTINGS_STORAGE_KEY]) {
    const nextSettings = changes[SETTINGS_STORAGE_KEY].newValue || {};
    sidebarPrefs = normalizeSidebarPrefs(
      nextSettings.sidebarPrefs || nextSettings.overlayPrefs
    );
    applySidebarExpandedState();
  }

  if (!changes[SESSION_STORAGE_KEY]) {
    return;
  }

  const previousSession = activeSession;
  activeSession = changes[SESSION_STORAGE_KEY].newValue || null;
  actionPending = false;

  if (!activeSession) {
    waitingForSubmissionResult = false;
    lastReportedSessionItem = null;
    overlayMessage = "";
    celebrationSessionId = null;
    removeAcceptedPrompt();
    removeCelebrationScreen();
    removeSidebarHost();
    removeHeaderTimer();
    return;
  }

  if (previousSession?.id !== activeSession.id) {
    waitingForSubmissionResult = false;
    lastReportedSessionItem = null;
    overlayMessage = "New session started.";
    celebrationSessionId = null;
    lastAutoResetSlug = null;
    removeCelebrationScreen();
    removeAcceptedPrompt();
    sidebarPrefs.expanded = true;
    void saveSidebarPrefs();
    void maybeScheduleEditorReset();
  } else if (previousSession?.currentIndex !== activeSession.currentIndex) {
    waitingForSubmissionResult = false;
    overlayMessage = "";
    removeAcceptedPrompt();
    void maybeScheduleEditorReset();
  } else if (
    getCurrentProblem(previousSession)?.slug !==
    getCurrentProblem(activeSession)?.slug
  ) {
    waitingForSubmissionResult = false;
    lastReportedSessionItem = null;
    overlayMessage = "New question loaded.";
    removeAcceptedPrompt();
    void maybeScheduleEditorReset();
  }

  if (isSessionComplete(activeSession)) {
    showCelebrationScreen();
  }

  renderSessionSidebar();
  renderHeaderTimer();
  syncTimerState();
}

function renderSessionSidebar() {
  if (!activeSession) {
    removeSidebarHost();
    removeHeaderTimer();
    return;
  }

  ensureSidebarHost();

  const shadow = sidebarHost.shadowRoot;
  const total = activeSession.queue.length;
  const currentProblem = getCurrentProblem();
  const isComplete = activeSession.currentIndex >= total;
  const isAccepted =
    Boolean(currentProblem) &&
    activeSession.acceptedSlug === currentProblem.slug;
  const isPaused = isSessionPaused();
  const progress = total
    ? Math.min((activeSession.currentIndex / total) * 100, 100)
    : 0;
  const position = isComplete
    ? `${total}/${total}`
    : `${activeSession.currentIndex + 1}/${total}`;
  const pageMatches = isCurrentQueuedPage();
  const isExpanded = sidebarPrefs.expanded;

  shadow.innerHTML = `
    <style>${getSidebarStyles()}</style>
    <aside class="sidebar ${isExpanded ? "expanded" : "collapsed"}" aria-label="LeetCode Randomizer session">
      <button
        class="toggle-tab"
        data-action="toggle"
        aria-expanded="${isExpanded}"
        aria-label="${isExpanded ? "Collapse session sidebar" : "Expand session sidebar"}"
        title="${isExpanded ? "Collapse sidebar" : "Expand sidebar"}"
      >
        <span class="chevron" aria-hidden="true">${isExpanded ? "›" : "‹"}</span>
        <span class="tab-label">LC</span>
        <span class="tab-progress">${position}</span>
      </button>

      <div class="panel">
        <header class="header">
          <div>
            <p class="eyebrow">Practice session</p>
            <h2>LeetCode Randomizer</h2>
          </div>
          <span class="state ${isAccepted ? "accepted" : ""}">
            ${isComplete ? "Complete" : isPaused ? "Paused" : isAccepted ? "Accepted" : "In progress"}
          </span>
        </header>

        <div class="timers">
          <div class="timer">
            <span class="timer-label">Session</span>
            <strong id="lr-session-timer">${formatElapsed(getSessionElapsed())}</strong>
          </div>
          <div class="timer">
            <span class="timer-label">Problem</span>
            <strong id="lr-problem-timer">${formatElapsed(getProblemElapsed())}</strong>
          </div>
        </div>

        <div class="progress-row">
          <span>Problem ${position.replace("/", " of ")}</span>
          <span>${activeSession.completedSlugs.length} solved</span>
        </div>
        <div class="progress-track" aria-hidden="true">
          <span style="width: ${progress}%"></span>
        </div>

        <section class="problem">
          <p class="label">${isComplete ? "Session complete" : "Current problem"}</p>
          <strong>${escapeHtml(currentProblem?.title || "Queue finished")}</strong>
          ${
            currentProblem
              ? `<span>${escapeHtml(currentProblem.difficulty)} · ${escapeHtml(
                  currentProblem.topics[0] || "General"
                )}</span>`
              : `<span>You reached the end of this queue.</span>`
          }
        </section>

        <div class="stats">
          <span><strong>${activeSession.completedSlugs.length}</strong>Solved</span>
          <span><strong>${activeSession.skippedSlugs?.length || 0}</strong>Skipped</span>
          <span><strong>${Math.max(total - activeSession.currentIndex, 0)}</strong>Left</span>
        </div>

        ${
          !isComplete && !pageMatches
            ? `<p class="notice">The current problem is open in another tab.</p>`
            : ""
        }
        ${
          overlayMessage
            ? `<p class="notice ${isAccepted ? "success" : ""}">${escapeHtml(
                overlayMessage
              )}</p>`
            : ""
        }

        <div class="primary-actions">
          <button class="button next" data-action="next" ${
            !isAccepted || isComplete || actionPending ? "disabled" : ""
          }>Next</button>
          <button class="button skip" data-action="skip" ${
            isComplete || actionPending ? "disabled" : ""
          }>Skip</button>
        </div>
        <div class="secondary-actions">
          <button class="text-button" data-action="pause" ${
            isComplete || actionPending ? "disabled" : ""
          }>${isPaused ? "Resume session" : "Pause session"}</button>
          <button class="text-button" data-action="regenerate" ${
            isComplete || actionPending ? "disabled" : ""
          }>Regenerate Question</button>
          <button class="text-button danger" data-action="end" ${
            actionPending ? "disabled" : ""
          }>End session</button>
        </div>
        <p class="shortcut-hint">${TOGGLE_SHORTCUT_LABEL} to expand/collapse</p>
      </div>
    </aside>
  `;

  for (const button of shadow.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => {
      if (button.dataset.action === "toggle") {
        void toggleSidebarExpanded();
        return;
      }

      void handleSidebarAction(button.dataset.action);
    });
  }
}

function ensureSidebarHost() {
  if (sidebarHost?.isConnected) {
    return;
  }

  sidebarHost = document.createElement("div");
  sidebarHost.id = "leetcode-randomizer-session-host";
  sidebarHost.style.position = "fixed";
  sidebarHost.style.top = "0";
  sidebarHost.style.right = "0";
  sidebarHost.style.height = "100vh";
  sidebarHost.style.zIndex = "2147483647";
  sidebarHost.attachShadow({ mode: "open" });
  document.documentElement.appendChild(sidebarHost);
}

function removeSidebarHost() {
  sidebarHost?.remove();
  sidebarHost = null;
}

function applySidebarExpandedState() {
  if (!sidebarHost?.shadowRoot) {
    return;
  }

  const sidebar = sidebarHost.shadowRoot.querySelector(".sidebar");
  const toggle = sidebarHost.shadowRoot.querySelector(".toggle-tab");
  if (!sidebar || !toggle) {
    return;
  }

  sidebar.classList.toggle("expanded", sidebarPrefs.expanded);
  sidebar.classList.toggle("collapsed", !sidebarPrefs.expanded);
  toggle.setAttribute("aria-expanded", String(sidebarPrefs.expanded));
  toggle.title = sidebarPrefs.expanded
    ? "Collapse sidebar"
    : "Expand sidebar";
  toggle.querySelector(".chevron").textContent = sidebarPrefs.expanded
    ? "›"
    : "‹";
}

async function toggleSidebarExpanded(nextExpanded = !sidebarPrefs.expanded) {
  sidebarPrefs.expanded = nextExpanded;
  applySidebarExpandedState();
  await saveSidebarPrefs();
}

function showAcceptedPrompt(slug, sessionId) {
  removeAcceptedPrompt();

  acceptedPromptHost = document.createElement("div");
  acceptedPromptHost.id = "leetcode-randomizer-accepted-host";
  acceptedPromptHost.style.position = "fixed";
  acceptedPromptHost.style.left = "50%";
  acceptedPromptHost.style.bottom = "28px";
  acceptedPromptHost.style.transform = "translateX(-50%)";
  acceptedPromptHost.style.zIndex = "2147483647";
  acceptedPromptHost.attachShadow({ mode: "open" });

  acceptedPromptHost.shadowRoot.innerHTML = `
    <style>${getAcceptedPromptStyles()}</style>
    <section class="prompt" aria-label="Accepted submission">
      <div class="copy">
        <strong>Correct</strong>
        <span>Ready for the next question?</span>
      </div>
      <button type="button" id="lr-accepted-next">Next</button>
    </section>
  `;

  acceptedPromptHost.shadowRoot
    .getElementById("lr-accepted-next")
    .addEventListener("click", async () => {
      await advanceFromAcceptedPrompt(slug, sessionId);
    });

  document.documentElement.appendChild(acceptedPromptHost);
}

async function advanceFromAcceptedPrompt(slug, sessionId) {
  if (actionPending) {
    return;
  }

  actionPending = true;
  removeAcceptedPrompt();
  overlayMessage = "Loading the next problem…";
  renderSessionSidebar();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ADVANCE_TO_NEXT_PROBLEM",
      slug,
      sessionId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not move to the next problem.");
    }

    if (response.status === "completed") {
      overlayMessage = "";
      actionPending = false;
      showCelebrationScreen();
      renderSessionSidebar();
      syncTimerState();
    }
  } catch (error) {
    console.error("Failed to advance from accepted prompt:", error);
    actionPending = false;
    overlayMessage = error.message;
    renderSessionSidebar();
    showAcceptedPrompt(slug, sessionId);
  }
}

function removeAcceptedPrompt() {
  acceptedPromptHost?.remove();
  acceptedPromptHost = null;
}

function getCelebrationStats() {
  const times = activeSession?.questionTimes || [];
  const totalMs = getSessionElapsed();
  const recordedTotal = times.reduce((sum, entry) => sum + entry.elapsedMs, 0);
  const averageMs = times.length ? Math.round(recordedTotal / times.length) : 0;

  return { totalMs, averageMs, times };
}

function showCelebrationScreen() {
  if (!activeSession || !isSessionComplete(activeSession)) {
    return;
  }

  if (celebrationSessionId === activeSession.id && celebrationHost?.isConnected) {
    return;
  }

  celebrationSessionId = activeSession.id;
  removeCelebrationScreen();
  removeAcceptedPrompt();

  const { totalMs, averageMs, times } = getCelebrationStats();
  const solvedCount = times.filter((entry) => entry.outcome === "completed").length;
  const skippedCount = times.length - solvedCount;

  celebrationHost = document.createElement("div");
  celebrationHost.id = "leetcode-randomizer-celebration-host";
  celebrationHost.style.position = "fixed";
  celebrationHost.style.inset = "0";
  celebrationHost.style.zIndex = "2147483647";
  celebrationHost.attachShadow({ mode: "open" });

  const questionRows = times.length
    ? times
        .map(
          (entry, index) => `
            <li class="question-row ${entry.outcome}">
              <span class="index">${index + 1}</span>
              <div class="question-info">
                <strong>${escapeHtml(entry.title)}</strong>
                <span class="meta">${escapeHtml(entry.difficulty)}</span>
              </div>
              <span class="outcome-badge">${entry.outcome === "completed" ? "Solved" : "Skipped"}</span>
              <span class="time">${formatElapsed(entry.elapsedMs)}</span>
            </li>
          `
        )
        .join("")
    : `<li class="empty">No question times recorded.</li>`;

  celebrationHost.shadowRoot.innerHTML = `
    <style>${getCelebrationStyles()}</style>
    <div class="backdrop" data-action="close" aria-hidden="true"></div>
    <section class="card" role="dialog" aria-labelledby="lr-celebration-title" aria-modal="true">
      <button class="close" type="button" data-action="close" aria-label="Close celebration screen">×</button>
      <p class="eyebrow">Queue complete</p>
      <h2 id="lr-celebration-title">Session complete!</h2>
      <p class="subtitle">${solvedCount} solved · ${skippedCount} skipped · ${times.length} total</p>

      <div class="stats-grid">
        <div class="stat">
          <span class="label">Total session time</span>
          <strong>${formatElapsed(totalMs)}</strong>
        </div>
        <div class="stat">
          <span class="label">Average per question</span>
          <strong>${formatElapsed(averageMs)}</strong>
        </div>
      </div>

      <div class="list-wrap">
        <p class="list-label">Time per question</p>
        <ol class="question-list">${questionRows}</ol>
      </div>

      <button class="end-button" type="button" data-action="end">End session</button>
    </section>
  `;

  for (const button of celebrationHost.shadowRoot.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => {
      if (button.dataset.action === "close") {
        removeCelebrationScreen();
        return;
      }

      if (button.dataset.action === "end") {
        void handleSidebarAction("end");
      }
    });
  }

  document.documentElement.appendChild(celebrationHost);
}

function removeCelebrationScreen() {
  celebrationHost?.remove();
  celebrationHost = null;
}

function getCelebrationStyles() {
  return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, .72);
      backdrop-filter: blur(4px);
    }
    .card {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(520px, calc(100vw - 32px));
      max-height: min(82vh, 720px);
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 24px;
      border: 1px solid rgba(148, 163, 184, .24);
      border-radius: 20px;
      background: linear-gradient(180deg, rgba(15, 23, 42, .98), rgba(15, 23, 42, .94));
      color: #f8fafc;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .45);
      overflow: hidden;
    }
    .close {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 999px;
      background: rgba(148, 163, 184, .14);
      color: #cbd5e1;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
    }
    .close:hover { background: rgba(148, 163, 184, .24); }
    .eyebrow {
      margin: 0;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: #a5b4fc;
    }
    h2 {
      margin: 0;
      font-size: 28px;
      line-height: 1.1;
      letter-spacing: -.02em;
    }
    .subtitle {
      margin: 0;
      color: #94a3b8;
      font-size: 14px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .stat {
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(30, 41, 59, .72);
      border: 1px solid rgba(148, 163, 184, .16);
    }
    .stat .label {
      display: block;
      margin-bottom: 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .stat strong {
      font-size: 24px;
      font-weight: 700;
      color: #e2e8f0;
      font-variant-numeric: tabular-nums;
    }
    .list-wrap {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
      flex: 1;
    }
    .list-label {
      margin: 0;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .question-list {
      margin: 0;
      padding: 0;
      list-style: none;
      overflow: auto;
      max-height: 280px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .question-row {
      display: grid;
      grid-template-columns: 28px 1fr auto auto;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(30, 41, 59, .55);
      border: 1px solid rgba(148, 163, 184, .12);
    }
    .question-row .index {
      font-size: 12px;
      font-weight: 700;
      color: #64748b;
      font-variant-numeric: tabular-nums;
    }
    .question-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .question-info strong {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .question-info .meta {
      font-size: 12px;
      color: #94a3b8;
    }
    .outcome-badge {
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .question-row.completed .outcome-badge {
      background: rgba(34, 197, 94, .16);
      color: #4ade80;
    }
    .question-row.skipped .outcome-badge {
      background: rgba(251, 191, 36, .14);
      color: #fbbf24;
    }
    .time {
      font-size: 14px;
      font-weight: 700;
      color: #e2e8f0;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .empty {
      padding: 16px;
      border-radius: 12px;
      background: rgba(30, 41, 59, .55);
      color: #94a3b8;
      font-size: 14px;
      text-align: center;
    }
    .end-button {
      width: 100%;
      margin-top: 4px;
      padding: 12px 16px;
      border: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform .15s ease, box-shadow .15s ease;
      box-shadow: 0 10px 24px rgba(79, 70, 229, .28);
    }
    .end-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 14px 28px rgba(79, 70, 229, .34);
    }
  `;
}

function renderHeaderTimer() {
  if (!activeSession) {
    removeHeaderTimer();
    return;
  }

  ensureHeaderTimerHost();
  mountHeaderTimer();

  const total = activeSession.queue.length;
  const isComplete = activeSession.currentIndex >= total;
  const position = isComplete
    ? `${total}/${total}`
    : `${activeSession.currentIndex + 1}/${total}`;

  headerTimerHost.shadowRoot.innerHTML = `
    <style>${getHeaderTimerStyles()}</style>
    <div class="timer-bar" aria-label="Practice session timers">
      <span class="progress">${position}</span>
      <span class="divider" aria-hidden="true"></span>
      <span class="timer">
        <span class="label">Session</span>
        <strong id="lr-header-session-timer">${formatElapsed(getSessionElapsed())}</strong>
      </span>
      <span class="divider" aria-hidden="true"></span>
      <span class="timer">
        <span class="label">Problem</span>
        <strong id="lr-header-problem-timer">${formatElapsed(getProblemElapsed())}</strong>
      </span>
    </div>
  `;
}

function ensureHeaderTimerHost() {
  if (headerTimerHost?.isConnected) {
    return;
  }

  headerTimerHost = document.createElement("div");
  headerTimerHost.id = "leetcode-randomizer-header-timer-host";
  headerTimerHost.attachShadow({ mode: "open" });
}

function mountHeaderTimer() {
  const anchor = findLeetCodeHeaderAnchor();
  if (anchor) {
    headerTimerHost.style.position = "";
    headerTimerHost.style.top = "";
    headerTimerHost.style.left = "";
    headerTimerHost.style.transform = "";
    headerTimerHost.style.zIndex = "";
    headerTimerHost.style.display = "flex";
    headerTimerHost.style.alignItems = "center";
    headerTimerHost.style.marginLeft = "auto";
    headerTimerHost.style.marginRight = "12px";
    if (headerTimerHost.parentElement !== anchor) {
      anchor.appendChild(headerTimerHost);
    }
    return;
  }

  headerTimerHost.style.display = "";
  headerTimerHost.style.alignItems = "";
  headerTimerHost.style.marginLeft = "";
  headerTimerHost.style.marginRight = "";

  if (headerTimerHost.parentElement !== document.documentElement) {
    document.documentElement.appendChild(headerTimerHost);
  }

  headerTimerHost.style.position = "fixed";
  headerTimerHost.style.top = "12px";
  headerTimerHost.style.left = "50%";
  headerTimerHost.style.transform = "translateX(-50%)";
  headerTimerHost.style.zIndex = "2147483646";
}

function findLeetCodeHeaderAnchor() {
  const selectors = [
    '[data-e2e-locator="navbar"]',
    "nav",
    'header [class*="navbar"]',
    'header [class*="nav"]',
    "header"
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
  }

  return null;
}

function removeHeaderTimer() {
  headerTimerHost?.remove();
  headerTimerHost = null;
}

async function saveSidebarPrefs() {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings = {
    autoResetEnabled: true,
    ...(stored[SETTINGS_STORAGE_KEY] || {})
  };

  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: {
      ...settings,
      sidebarPrefs
    }
  });
}

function updateTimerDisplay() {
  if (!activeSession) {
    return;
  }

  if (!headerTimerHost?.isConnected) {
    renderHeaderTimer();
  }

  const sessionText = formatElapsed(getSessionElapsed());
  const problemText = formatElapsed(getProblemElapsed());

  if (sidebarHost?.shadowRoot) {
    const sessionTimer = sidebarHost.shadowRoot.getElementById("lr-session-timer");
    const problemTimer = sidebarHost.shadowRoot.getElementById("lr-problem-timer");
    const progressTab = sidebarHost.shadowRoot.querySelector(".tab-progress");

    if (sessionTimer) {
      sessionTimer.textContent = sessionText;
    }

    if (problemTimer) {
      problemTimer.textContent = problemText;
    }

    if (progressTab) {
      const total = activeSession.queue.length;
      const isComplete = activeSession.currentIndex >= total;
      progressTab.textContent = isComplete
        ? `${total}/${total}`
        : `${activeSession.currentIndex + 1}/${total}`;
    }
  }

  if (headerTimerHost?.shadowRoot) {
    const headerSessionTimer = headerTimerHost.shadowRoot.getElementById(
      "lr-header-session-timer"
    );
    const headerProblemTimer = headerTimerHost.shadowRoot.getElementById(
      "lr-header-problem-timer"
    );

    if (headerSessionTimer) {
      headerSessionTimer.textContent = sessionText;
    }

    if (headerProblemTimer) {
      headerProblemTimer.textContent = problemText;
    }
  }
}

function getSessionElapsed() {
  const endTime = getTimerEndTime();
  const activeElapsed =
    endTime - (activeSession?.startedAt || endTime) - getTotalPausedMs();
  return Math.max(0, activeElapsed);
}

function getProblemElapsed() {
  const endTime = getTimerEndTime();
  const startedAt =
    activeSession?.currentProblemStartedAt || activeSession?.startedAt || endTime;
  const activeElapsed = endTime - startedAt - getCurrentProblemPausedMs();
  return Math.max(0, activeElapsed);
}

function getTimerEndTime() {
  if (!activeSession) {
    return Date.now();
  }

  return activeSession.completedAt || activeSession.pausedAt || Date.now();
}

function getTotalPausedMs() {
  return activeSession?.totalPausedMs || 0;
}

function getCurrentProblemPausedMs() {
  return activeSession?.currentProblemPausedMs || 0;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function handleSidebarAction(action) {
  if (!activeSession || actionPending) {
    return;
  }

  const currentProblem = getCurrentProblem();
  const messages = {
    next: {
      type: "ADVANCE_TO_NEXT_PROBLEM",
      slug: currentProblem?.slug,
      sessionId: activeSession.id
    },
    skip: {
      type: "SKIP_CURRENT_PROBLEM",
      slug: currentProblem?.slug,
      sessionId: activeSession.id
    },
    pause: {
      type: "TOGGLE_SESSION_PAUSE",
      sessionId: activeSession.id
    },
    regenerate: {
      type: "REGENERATE_CURRENT_QUESTION",
      slug: currentProblem?.slug,
      sessionId: activeSession.id
    },
    end: {
      type: "END_SESSION",
      sessionId: activeSession.id
    }
  };

  const message = messages[action];
  if (!message) {
    return;
  }

  actionPending = true;
  overlayMessage =
    action === "pause"
      ? activeSession.isPaused
        ? "Resuming session…"
        : "Pausing session…"
      : action === "regenerate"
      ? "Picking a new question…"
      : action === "end"
        ? "Ending session…"
        : "Loading the next problem…";
  renderSessionSidebar();

  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "The session action failed.");
    }

    if (response.status === "completed") {
      overlayMessage = "";
      actionPending = false;
      showCelebrationScreen();
      syncTimerState();
    } else if (response.status === "paused") {
      overlayMessage = "Session paused.";
      actionPending = false;
      syncTimerState();
    } else if (response.status === "resumed") {
      overlayMessage = "Session resumed.";
      actionPending = false;
      syncTimerState();
    } else if (response.status === "question_regenerated") {
      waitingForSubmissionResult = false;
      lastReportedSessionItem = null;
      overlayMessage = "Loaded a new question.";
      actionPending = false;
      syncTimerState();
    }
  } catch (error) {
    console.error(`Failed to ${action} session:`, error);
    actionPending = false;
    overlayMessage = error.message;
    renderSessionSidebar();
  }
}

function getSidebarStyles() {
  return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .sidebar {
      display: flex;
      height: 100vh;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }
    .sidebar > * { pointer-events: auto; }
    .toggle-tab {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 38px;
      margin-top: 88px;
      padding: 12px 6px;
      border: 1px solid rgba(148, 163, 184, .22);
      border-right: 0;
      border-radius: 14px 0 0 14px;
      background: rgba(15, 23, 42, .96);
      color: #f8fafc;
      box-shadow: -8px 0 24px rgba(0, 0, 0, .22);
      cursor: pointer;
      transition: background-color .15s ease, transform .15s ease;
    }
    .toggle-tab:hover { background: rgba(30, 41, 59, .98); }
    .chevron {
      font-size: 18px;
      line-height: 1;
      color: #a5b4fc;
      font-weight: 700;
    }
    .tab-label {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .12em;
      color: #818cf8;
    }
    .tab-progress {
      font-size: 11px;
      font-weight: 700;
      color: #cbd5e1;
      font-variant-numeric: tabular-nums;
    }
    .panel {
      width: 320px;
      height: 100vh;
      overflow-y: auto;
      padding: 18px 16px 24px;
      border-left: 1px solid rgba(148, 163, 184, .18);
      background: rgba(15, 23, 42, .96);
      color: #f8fafc;
      box-shadow: -12px 0 40px rgba(0, 0, 0, .28);
      backdrop-filter: blur(18px);
      font-size: 13px;
      line-height: 1.4;
      transition: transform .24s ease, opacity .24s ease;
    }
    .sidebar.collapsed .panel {
      width: 0;
      padding: 0;
      opacity: 0;
      overflow: hidden;
      transform: translateX(100%);
      border-left: 0;
      box-shadow: none;
    }
    .sidebar.expanded .panel {
      opacity: 1;
      transform: translateX(0);
    }
    .header, .progress-row, .primary-actions, .secondary-actions, .stats, .timers {
      display: flex;
      align-items: center;
    }
    .header { justify-content: space-between; gap: 12px; }
    .eyebrow {
      margin: 0 0 2px;
      color: #818cf8;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    h2 { margin: 0; font-size: 16px; letter-spacing: -.02em; }
    .state {
      flex: 0 0 auto;
      padding: 5px 8px;
      border-radius: 999px;
      background: rgba(148, 163, 184, .12);
      color: #cbd5e1;
      font-size: 10px;
      font-weight: 700;
    }
    .state.accepted { background: rgba(34, 197, 94, .16); color: #86efac; }
    .timers {
      justify-content: space-between;
      gap: 8px;
      margin-top: 16px;
      padding: 10px 12px;
      border: 1px solid rgba(148, 163, 184, .12);
      border-radius: 12px;
      background: rgba(255, 255, 255, .04);
    }
    .timer { flex: 1; }
    .timer-label {
      display: block;
      color: #94a3b8;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .timer strong {
      display: block;
      margin-top: 2px;
      font-size: 18px;
      letter-spacing: -.02em;
      font-variant-numeric: tabular-nums;
    }
    .progress-row {
      justify-content: space-between;
      margin-top: 14px;
      color: #94a3b8;
      font-size: 11px;
    }
    .progress-track {
      height: 5px;
      margin-top: 7px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(148, 163, 184, .14);
    }
    .progress-track span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #6366f1, #8b5cf6);
      transition: width .25s ease;
    }
    .problem {
      margin-top: 14px;
      padding: 12px;
      border: 1px solid rgba(148, 163, 184, .12);
      border-radius: 12px;
      background: rgba(255, 255, 255, .04);
    }
    .problem .label {
      margin: 0 0 3px;
      color: #94a3b8;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .problem strong { display: block; font-size: 14px; }
    .problem span { display: block; margin-top: 3px; color: #94a3b8; font-size: 11px; }
    .stats {
      justify-content: space-around;
      margin-top: 12px;
      padding: 10px 0;
      border-top: 1px solid rgba(148, 163, 184, .1);
      border-bottom: 1px solid rgba(148, 163, 184, .1);
    }
    .stats span { color: #94a3b8; font-size: 10px; text-align: center; }
    .stats strong { display: block; color: #f8fafc; font-size: 15px; }
    .notice {
      margin: 10px 0 0;
      padding: 8px 10px;
      border-radius: 9px;
      background: rgba(99, 102, 241, .12);
      color: #c7d2fe;
      font-size: 11px;
    }
    .notice.success { background: rgba(34, 197, 94, .12); color: #86efac; }
    .primary-actions { gap: 8px; margin-top: 12px; }
    .button {
      flex: 1;
      min-height: 38px;
      border: 0;
      border-radius: 10px;
      color: white;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .next { background: linear-gradient(135deg, #6366f1, #7c3aed); }
    .skip { background: rgba(255, 255, 255, .09); }
    .button:disabled, .text-button:disabled { opacity: .38; cursor: not-allowed; }
    .secondary-actions { justify-content: space-between; margin-top: 10px; }
    .text-button {
      border: 0;
      padding: 4px;
      background: transparent;
      color: #a5b4fc;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .text-button.danger { color: #fca5a5; }
    .shortcut-hint {
      margin: 10px 0 0;
      color: #64748b;
      font-size: 10px;
      text-align: center;
    }
  `;
}

function getAcceptedPromptStyles() {
  return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .prompt {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 260px;
      padding: 12px 12px 12px 14px;
      border: 1px solid rgba(34, 197, 94, .25);
      border-radius: 16px;
      background: rgba(15, 23, 42, .96);
      color: #f8fafc;
      box-shadow: 0 18px 45px rgba(0, 0, 0, .35);
      backdrop-filter: blur(18px);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .copy {
      display: flex;
      flex: 1;
      min-width: 0;
      flex-direction: column;
      gap: 2px;
    }
    strong {
      color: #86efac;
      font-size: 14px;
      line-height: 1.2;
    }
    span {
      color: #cbd5e1;
      font-size: 12px;
      line-height: 1.3;
    }
    button {
      min-height: 36px;
      border: 0;
      border-radius: 10px;
      padding: 0 14px;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      color: #ffffff;
      font: inherit;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }
    button:hover {
      filter: brightness(1.05);
    }
  `;
}

function getHeaderTimerStyles() {
  return `
    :host {
      display: block;
      pointer-events: none;
    }
    * { box-sizing: border-box; }
    .timer-bar {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 6px 12px;
      border: 1px solid rgba(148, 163, 184, .2);
      border-radius: 999px;
      background: rgba(15, 23, 42, .92);
      color: #f8fafc;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .22);
      backdrop-filter: blur(14px);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1;
      white-space: nowrap;
    }
    .progress {
      color: #a5b4fc;
      font-size: 11px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    .divider {
      width: 1px;
      height: 14px;
      background: rgba(148, 163, 184, .24);
    }
    .timer {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
    }
    .label {
      color: #94a3b8;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    strong {
      color: #f8fafc;
      font-size: 13px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
  `;
}

function getProblemSlug() {
  const match = window.location.pathname.match(/^\/problems\/([^/]+)/);
  return match ? match[1] : null;
}

function getCurrentProblem() {
  return activeSession?.queue?.[activeSession.currentIndex] || null;
}

function isCurrentQueuedPage() {
  const currentProblem = getCurrentProblem();
  return Boolean(currentProblem && getProblemSlug() === currentProblem.slug);
}

function getSubmissionResultText() {
  for (const selector of RESULT_CONTAINER_SELECTORS) {
    const container = document.querySelector(selector);
    if (!container) {
      continue;
    }

    const text = container.innerText || container.textContent || "";
    if (text.trim()) {
      return text;
    }
  }

  return "";
}

function hasFailureResult(pageText) {
  return FAILURE_TEXTS.some((text) => pageText.includes(text));
}

function isSubmitAction(element) {
  const text = normalizeText(element.textContent);
  if (text.includes("submit")) {
    return true;
  }

  const attributes = [
    element.getAttribute("data-e2e-locator"),
    element.getAttribute("data-cy"),
    element.getAttribute("id"),
    element.getAttribute("aria-label"),
    element.getAttribute("title")
  ]
    .filter(Boolean)
    .map(normalizeText);

  return attributes.some((value) =>
    SUBMIT_LOCATOR_TEXTS.some((candidate) => value.includes(candidate))
  );
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

async function maybeScheduleEditorReset() {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings = {
    autoResetEnabled: true,
    ...(stored[SETTINGS_STORAGE_KEY] || {})
  };

  if (!settings.autoResetEnabled || !isCurrentQueuedPage()) {
    return;
  }

  const slug = getProblemSlug();
  if (!slug || slug === lastAutoResetSlug) {
    return;
  }

  scheduleEditorReset(slug);
}

async function scheduleEditorReset(expectedSlug) {
  if (!expectedSlug) {
    return;
  }

  try {
    const resetButton = await waitForResetButton(expectedSlug);
    if (!resetButton || getProblemSlug() !== expectedSlug) {
      return;
    }

    resetButton.click();

    await sleep(RESET_CONFIRM_DELAY_MS);
    const confirmButton = await waitForResetConfirmButton(expectedSlug);
    if (!confirmButton || getProblemSlug() !== expectedSlug) {
      return;
    }

    confirmButton.click();
    lastAutoResetSlug = expectedSlug;
  } catch (error) {
    console.error("Failed to auto-reset editor:", error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function evaluateXpath(xpath) {
  const snapshot = document.evaluate(
    xpath,
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );

  return Array.from({ length: snapshot.snapshotLength }, (_, index) =>
    snapshot.snapshotItem(index)
  );
}

function waitForElementsByXpath(xpath, expectedSlug) {
  return new Promise((resolve) => {
    const found = evaluateXpath(xpath);
    if (found.length) {
      resolve(found);
      return;
    }

    let settled = false;
    const observer = new MutationObserver(() => {
      if (expectedSlug && getProblemSlug() !== expectedSlug) {
        finish([]);
        return;
      }

      const elements = evaluateXpath(xpath);
      if (elements.length) {
        finish(elements);
      }
    });

    const timeoutId = window.setTimeout(() => finish([]), RESET_WAIT_TIMEOUT_MS);

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      observer.disconnect();
      resolve(result);
    }

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  });
}

async function waitForResetButton(expectedSlug) {
  const iconMatchers = RESET_ICON_PATHS.map(
    (path) => `.//*[@d="${path}"]`
  ).join(" or ");

  const xpath = `//*[@id="editor"]//button[${iconMatchers}]`;
  const [button] = await waitForElementsByXpath(xpath, expectedSlug);
  return button || null;
}

async function waitForResetConfirmButton(expectedSlug) {
  const xpath = `//*[@role="dialog" and contains(., "${RESET_CONFIRM_MESSAGE}")]//button[contains(., "Confirm")]`;
  const [button] = await waitForElementsByXpath(xpath, expectedSlug);
  return button || null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
