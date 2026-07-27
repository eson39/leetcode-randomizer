const PROBLEM_LIST_NEETCODE_150 = "neetcode150";
const PROBLEM_LIST_BLIND_75 = "blind75";
const DEFAULT_PROBLEM_LIST = PROBLEM_LIST_NEETCODE_150;

function getProblemsForList(allProblems, problemList, blind75Slugs) {
  if (problemList === PROBLEM_LIST_BLIND_75) {
    const allowed = new Set(blind75Slugs || []);
    return allProblems.filter((problem) => allowed.has(problem.slug));
  }

  return allProblems;
}
