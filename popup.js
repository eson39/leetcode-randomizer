const DATA_PATH = "data/problems.json";
const SESSION_STORAGE_KEY = "activeSession";
const SETTINGS_STORAGE_KEY = "settings";
const DEFAULT_QUESTION_COUNT = 5;
const MAX_QUESTION_COUNT = 10;
const DEFAULT_SETTINGS = {
  autoResetEnabled: true
};

const state = {
  problems: [],
  settings: { ...DEFAULT_SETTINGS }
};

const elements = {
  form: document.getElementById("filters-form"),
  topicSelect: document.getElementById("topic-select"),
  questionCountSelect: document.getElementById("question-count"),
  questionCountHint: document.getElementById("question-count-hint"),
  statusMessage: document.getElementById("status-message"),
  autoResetEnabled: document.getElementById("auto-reset-enabled"),
  startButton: document.getElementById("generate-button")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();

  try {
    state.problems = await loadProblems();
    populateTopicOptions(state.problems);
    await loadStoredSettings();
    hydrateSettingsForm();
    updateQuestionCountOptions();
  } catch (error) {
    console.error("Failed to initialize extension:", error);
    setStatusMessage("Could not load problem data. Reload the extension.");
    elements.startButton.disabled = true;
  }
}

function bindEvents() {
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await startSession();
  });

  elements.topicSelect.addEventListener("change", updateQuestionCountOptions);

  for (const input of elements.form.querySelectorAll('input[name="difficulty"]')) {
    input.addEventListener("change", updateQuestionCountOptions);
  }

  elements.autoResetEnabled.addEventListener("change", async () => {
    state.settings.autoResetEnabled = elements.autoResetEnabled.checked;
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: state.settings
    });
  });
}

async function loadProblems() {
  const response = await fetch(chrome.runtime.getURL(DATA_PATH));
  if (!response.ok) {
    throw new Error(`Failed to load problems.json: ${response.status}`);
  }

  return response.json();
}

async function loadStoredSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_STORAGE_KEY] || {})
  };
}

function hydrateSettingsForm() {
  elements.autoResetEnabled.checked = state.settings.autoResetEnabled;
}

function populateTopicOptions(problems) {
  const topics = Array.from(
    new Set(problems.flatMap((problem) => problem.topics))
  ).sort((a, b) => a.localeCompare(b));

  for (const topic of topics) {
    const option = document.createElement("option");
    option.value = topic;
    option.textContent = topic;
    elements.topicSelect.appendChild(option);
  }
}

function getFilters() {
  const formData = new FormData(elements.form);
  return {
    count: Number(formData.get("count")),
    difficulties: formData.getAll("difficulty"),
    topic: formData.get("topic") || ""
  };
}

function filterProblems(filters) {
  return state.problems.filter((problem) => {
    const matchesDifficulty = filters.difficulties.includes(problem.difficulty);
    const matchesTopic =
      !filters.topic || problem.topics.includes(filters.topic);

    return matchesDifficulty && matchesTopic;
  });
}

function getMatchingProblemCount(filters = getFilters()) {
  if (!filters.difficulties.length) {
    return 0;
  }

  return filterProblems(filters).length;
}

function updateQuestionCountOptions() {
  const filters = getFilters();
  const matchingCount = getMatchingProblemCount(filters);
  const previousCount = Number(elements.questionCountSelect.value) || DEFAULT_QUESTION_COUNT;

  elements.questionCountSelect.replaceChildren();

  if (!filters.difficulties.length) {
    elements.questionCountSelect.disabled = true;
    elements.startButton.disabled = true;
    elements.questionCountHint.textContent =
      "Select at least one difficulty to choose a session size.";
    return;
  }

  if (matchingCount === 0) {
    elements.questionCountSelect.disabled = true;
    elements.startButton.disabled = true;
    elements.questionCountHint.textContent = filters.topic
      ? `No ${filters.topic} problems match the selected difficulties.`
      : "No problems match the selected difficulties.";
    return;
  }

  const maxSelectable = Math.min(MAX_QUESTION_COUNT, matchingCount);

  for (let count = 1; count <= maxSelectable; count += 1) {
    const option = document.createElement("option");
    option.value = String(count);
    option.textContent = String(count);
    elements.questionCountSelect.appendChild(option);
  }

  const nextCount = Math.min(Math.max(previousCount, 1), maxSelectable);
  elements.questionCountSelect.value = String(nextCount);
  elements.questionCountSelect.disabled = false;
  elements.startButton.disabled = false;

  if (filters.topic) {
    elements.questionCountHint.textContent =
      matchingCount === 1
        ? `1 ${filters.topic} problem available.`
        : `${matchingCount} ${filters.topic} problems available. Max session size: ${maxSelectable}.`;
  } else if (matchingCount > MAX_QUESTION_COUNT) {
    elements.questionCountHint.textContent = `${matchingCount} problems available. You can queue up to ${MAX_QUESTION_COUNT}.`;
  } else {
    elements.questionCountHint.textContent =
      matchingCount === 1
        ? "1 problem available with these filters."
        : `${matchingCount} problems available with these filters.`;
  }
}

function shuffle(problems) {
  const copy = [...problems];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }

  return copy;
}

async function startSession() {
  const filters = getFilters();

  if (!filters.difficulties.length) {
    setStatusMessage("Select at least one difficulty.");
    return;
  }

  const matchingProblems = filterProblems(filters);
  const queue = shuffle(matchingProblems).slice(0, filters.count);

  if (!queue.length) {
    setStatusMessage("No problems matched those filters.");
    updateQuestionCountOptions();
    return;
  }

  elements.startButton.disabled = true;
  setStatusMessage("Starting session…");

  const session = {
    id: crypto.randomUUID(),
    filters,
    queue,
    totalMatches: matchingProblems.length,
    currentIndex: 0,
    completedSlugs: [],
    skippedSlugs: [],
    acceptedSlug: null,
    startedAt: Date.now(),
    currentProblemStartedAt: Date.now(),
    isPaused: false,
    pausedAt: null,
    totalPausedMs: 0,
    currentProblemPausedMs: 0,
    completedAt: null,
    questionTimes: []
  };

  try {
    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session });
    const response = await chrome.runtime.sendMessage({
      type: "OPEN_CURRENT_PROBLEM"
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not open the first problem.");
    }

    window.close();
  } catch (error) {
    console.error("Failed to start session:", error);
    setStatusMessage(error.message);
    elements.startButton.disabled = false;
  }
}

function setStatusMessage(message) {
  elements.statusMessage.textContent = message;
}
