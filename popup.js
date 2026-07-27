const DATA_PATH = "data/problems.json";
const BLIND75_SLUGS_PATH = "data/blind75-slugs.json";
const SESSION_STORAGE_KEY = "activeSession";
const SETTINGS_STORAGE_KEY = "settings";
const DEFAULT_QUESTION_COUNT = 5;
const MAX_QUESTION_COUNT = 10;
const DEFAULT_SETTINGS = {
  autoResetEnabled: true,
  problemList: DEFAULT_PROBLEM_LIST
};

const state = {
  problems: [],
  blind75Slugs: [],
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
    state.blind75Slugs = await loadBlind75Slugs();
    await loadStoredSettings();
    hydrateSettingsForm();
    populateTopicOptions();
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

  for (const input of elements.form.querySelectorAll('input[name="problemList"]')) {
    input.addEventListener("change", async () => {
      state.settings.problemList = getSelectedProblemList();
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: state.settings
      });
      populateTopicOptions();
      updateQuestionCountOptions();
    });
  }

  elements.autoResetEnabled.addEventListener("change", async () => {
    state.settings.autoResetEnabled = elements.autoResetEnabled.checked;
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: state.settings
    });
  });
}

async function loadBlind75Slugs() {
  const response = await fetch(chrome.runtime.getURL(BLIND75_SLUGS_PATH));
  if (!response.ok) {
    throw new Error(`Failed to load blind75-slugs.json: ${response.status}`);
  }

  return response.json();
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

  if (
    state.settings.problemList !== PROBLEM_LIST_NEETCODE_150 &&
    state.settings.problemList !== PROBLEM_LIST_BLIND_75
  ) {
    state.settings.problemList = DEFAULT_PROBLEM_LIST;
  }
}

function hydrateSettingsForm() {
  elements.autoResetEnabled.checked = state.settings.autoResetEnabled;

  const problemListInput = elements.form.querySelector(
    `input[name="problemList"][value="${state.settings.problemList}"]`
  );
  if (problemListInput) {
    problemListInput.checked = true;
  }
}

function getSelectedProblemList() {
  const selected = elements.form.querySelector('input[name="problemList"]:checked');
  return selected?.value || DEFAULT_PROBLEM_LIST;
}

function getActiveProblemPool() {
  return getProblemsForList(
    state.problems,
    getSelectedProblemList(),
    state.blind75Slugs
  );
}

function populateTopicOptions() {
  const pool = getActiveProblemPool();
  const topics = Array.from(
    new Set(pool.flatMap((problem) => problem.topics))
  ).sort((a, b) => a.localeCompare(b));

  const previousTopic = elements.topicSelect.value;
  elements.topicSelect.replaceChildren();

  const allTopicsOption = document.createElement("option");
  allTopicsOption.value = "";
  allTopicsOption.textContent = "All topics";
  elements.topicSelect.appendChild(allTopicsOption);

  for (const topic of topics) {
    const option = document.createElement("option");
    option.value = topic;
    option.textContent = topic;
    elements.topicSelect.appendChild(option);
  }

  if (previousTopic && topics.includes(previousTopic)) {
    elements.topicSelect.value = previousTopic;
  }
}

function getFilters() {
  const formData = new FormData(elements.form);
  return {
    count: Number(formData.get("count")),
    difficulties: formData.getAll("difficulty"),
    topic: formData.get("topic") || "",
    problemList: formData.get("problemList") || DEFAULT_PROBLEM_LIST
  };
}

function filterProblems(filters) {
  const pool = getProblemsForList(
    state.problems,
    filters.problemList,
    state.blind75Slugs
  );

  return pool.filter((problem) => {
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
    const listLabel =
      filters.problemList === PROBLEM_LIST_BLIND_75 ? "Blind 75" : "NeetCode 150";
    elements.questionCountHint.textContent = filters.topic
      ? `No ${filters.topic} problems in ${listLabel} match the selected difficulties.`
      : `No problems in ${listLabel} match the selected difficulties.`;
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
