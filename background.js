const SESSION_STORAGE_KEY = "activeSession";
const DATA_PATH = "data/problems.json";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    OPEN_CURRENT_PROBLEM: () => openCurrentProblem(),
    LEETCODE_PROBLEM_ACCEPTED: () =>
      markProblemAccepted(message.slug, message.sessionId),
    ADVANCE_TO_NEXT_PROBLEM: () =>
      advanceToNextProblem(message.slug, message.sessionId, sender.tab?.id),
    SKIP_CURRENT_PROBLEM: () =>
      skipCurrentProblem(message.slug, message.sessionId, sender.tab?.id),
    TOGGLE_SESSION_PAUSE: () => toggleSessionPause(message.sessionId),
    END_SESSION: () => endSession(message.sessionId),
    REGENERATE_CURRENT_QUESTION: () =>
      regenerateCurrentQuestion(
        message.slug,
        message.sessionId,
        sender.tab?.id
      )
  };

  const handler = handlers[message?.type];
  if (!handler) {
    return false;
  }

  handler()
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error(`Failed to handle ${message.type}:`, error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function openCurrentProblem() {
  const session = await getSession();
  const currentProblem = getCurrentProblem(session);

  if (!session) {
    return { ok: false, error: "No active session." };
  }

  if (!currentProblem) {
    return { ok: false, error: "Session is already complete." };
  }

  await chrome.tabs.create({ url: currentProblem.url });
  return { ok: true, slug: currentProblem.slug };
}

async function markProblemAccepted(slug, sessionId) {
  const session = await getSession();
  const validationError = validateCurrentProblem(session, slug, sessionId);
  if (validationError) {
    return validationError;
  }

  session.acceptedSlug = slug;
  await setSession(session);
  return { ok: true, status: "ready_to_advance", slug };
}

async function advanceToNextProblem(slug, sessionId, tabId) {
  const session = await getSession();
  const validationError = validateCurrentProblem(session, slug, sessionId);
  if (validationError) {
    return validationError;
  }

  if (session.acceptedSlug !== slug) {
    return {
      ok: false,
      error: "Next unlocks after this problem receives an accepted submission."
    };
  }

  if (!session.completedSlugs.includes(slug)) {
    session.completedSlugs.push(slug);
  }

  return moveToNextProblem(session, "advanced", tabId);
}

async function skipCurrentProblem(slug, sessionId, tabId) {
  const session = await getSession();
  const validationError = validateCurrentProblem(session, slug, sessionId);
  if (validationError) {
    return validationError;
  }

  if (!session.skippedSlugs.includes(slug)) {
    session.skippedSlugs.push(slug);
  }

  return moveToNextProblem(session, "skipped", tabId);
}

function recordCurrentProblemTime(session, outcome) {
  const problem = getCurrentProblem(session);
  if (!problem) {
    return;
  }

  const endedAt = getEffectiveNow(session);
  const startedAt = session.currentProblemStartedAt || session.startedAt;
  const elapsedMs = Math.max(
    0,
    endedAt - startedAt - (session.currentProblemPausedMs || 0)
  );

  session.questionTimes ||= [];
  session.questionTimes.push({
    slug: problem.slug,
    title: problem.title,
    difficulty: problem.difficulty,
    elapsedMs,
    outcome
  });
}

async function moveToNextProblem(session, status, tabId) {
  const outcome = status === "skipped" ? "skipped" : "completed";
  recordCurrentProblemTime(session, outcome);

  session.currentIndex += 1;
  session.acceptedSlug = null;

  const nextProblem = getCurrentProblem(session);
  if (!nextProblem) {
    session.completedAt = getEffectiveNow(session);
    await setSession(session);
    return { ok: true, status: "completed" };
  }

  session.currentProblemStartedAt = Date.now();
  session.currentProblemPausedMs = 0;
  session.completedAt = null;
  await setSession(session);

  await navigateToProblem(tabId, nextProblem.url);
  return { ok: true, status, nextSlug: nextProblem.slug };
}

async function navigateToProblem(tabId, url) {
  if (tabId) {
    await chrome.tabs.update(tabId, { url });
    return;
  }

  await chrome.tabs.create({ url });
}

async function endSession(sessionId) {
  const session = await getSession();
  if (!session) {
    return { ok: true, status: "ended" };
  }

  if (sessionId && session.id !== sessionId) {
    return { ok: false, error: "This session is no longer active." };
  }

  await chrome.storage.local.remove(SESSION_STORAGE_KEY);
  return { ok: true, status: "ended" };
}

async function toggleSessionPause(sessionId) {
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "No active session." };
  }

  if (sessionId && session.id !== sessionId) {
    return { ok: false, error: "This session is no longer active." };
  }

  if (session.completedAt || session.currentIndex >= session.queue.length) {
    return { ok: false, error: "Session is already complete." };
  }

  if (session.isPaused) {
    const pausedDuration = Date.now() - session.pausedAt;
    session.totalPausedMs += pausedDuration;
    session.currentProblemPausedMs += pausedDuration;
    session.pausedAt = null;
    session.isPaused = false;
    await setSession(session);
    return { ok: true, status: "resumed" };
  }

  session.pausedAt = Date.now();
  session.isPaused = true;
  await setSession(session);
  return { ok: true, status: "paused" };
}

async function regenerateCurrentQuestion(slug, sessionId, tabId) {
  const session = await getSession();
  const validationError = validateCurrentProblem(session, slug, sessionId);
  if (validationError) {
    return validationError;
  }

  const problems = await loadProblems();
  const matchingProblems = filterProblems(problems, session.filters);
  const usedSlugs = new Set(session.queue.map((problem) => problem.slug));
  const candidates = matchingProblems.filter(
    (problem) => !usedSlugs.has(problem.slug)
  );

  if (!candidates.length) {
    return {
      ok: false,
      error: "No alternate problems matched your filters."
    };
  }

  const replacement = shuffle(candidates)[0];
  session.queue[session.currentIndex] = replacement;
  session.acceptedSlug = null;
  session.currentProblemStartedAt = Date.now();
  session.currentProblemPausedMs = 0;
  session.completedAt = null;
  await setSession(session);

  if (tabId) {
    await chrome.tabs.update(tabId, { url: replacement.url });
  } else {
    await navigateToProblem(null, replacement.url);
  }

  return {
    ok: true,
    status: "question_regenerated",
    slug: replacement.slug
  };
}

async function loadProblems() {
  const response = await fetch(chrome.runtime.getURL(DATA_PATH));
  if (!response.ok) {
    throw new Error(`Failed to load problems.json: ${response.status}`);
  }

  return response.json();
}

function filterProblems(problems, filters) {
  return problems.filter((problem) => {
    const matchesDifficulty = filters.difficulties.includes(problem.difficulty);
    const matchesTopic =
      !filters.topic || problem.topics.includes(filters.topic);

    return matchesDifficulty && matchesTopic;
  });
}

function shuffle(problems) {
  const copy = [...problems];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }

  return copy;
}

function validateCurrentProblem(session, slug, sessionId) {
  if (!session) {
    return { ok: false, error: "No active session." };
  }

  if (sessionId && session.id !== sessionId) {
    return { ok: false, error: "This session is no longer active." };
  }

  const currentProblem = getCurrentProblem(session);
  if (!currentProblem || currentProblem.slug !== slug) {
    return { ok: false, error: "This is not the current queued problem." };
  }

  return null;
}

function getCurrentProblem(session) {
  return session?.queue?.[session.currentIndex] || null;
}

function getEffectiveNow(session) {
  return session.isPaused ? session.pausedAt : Date.now();
}

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  const session = stored[SESSION_STORAGE_KEY] || null;
  if (!session) {
    return null;
  }

  session.completedSlugs ||= [];
  session.skippedSlugs ||= [];
  session.acceptedSlug ??= null;
  session.currentProblemStartedAt ??= session.startedAt;
  session.isPaused ??= false;
  session.pausedAt ??= null;
  session.totalPausedMs ??= 0;
  session.currentProblemPausedMs ??= 0;
  session.completedAt ??= null;
  session.questionTimes ??= [];
  if (session.currentIndex >= session.queue.length && !session.completedAt) {
    session.completedAt = getEffectiveNow(session);
  }
  return session;
}

async function setSession(session) {
  await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session });
}
