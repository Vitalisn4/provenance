// Every threshold the system uses, with where it comes from.
export const policy = {
  zetaris: {
    // Technical Execution Guide, section 5: 30-60 s per Zetaris SQL request.
    timeoutMs: 60_000,
    // Our choice: network failures and HTTP 5xx are retried twice, after 0.5 s and then 1 s.
    maxRetries: 2,
    retryBaseDelayMs: 500,
    // Zetaris truncates silently at the requested limit and reports the truncated count as `total`,
    // so a result that reaches it is treated as an error.
    resultLimit: 10_000,
  },
  meterless: {
    // Provider contract (Runtime 1.4): a chat call may take up to 180 s, because a model load can take minutes.
    chatTimeoutMs: 180_000,
    // Our choice: a runtime that gives no status within 10 s counts as offline.
    statusTimeoutMs: 10_000,
    // Provider contract: a 429 is retried after 2, 4 and 8 s, then surfaces. Our choice: network failures and
    // 5xx follow the same schedule.
    maxRetries: 3,
    retryBaseDelayMs: 2_000,
    // Each lane is pinned to its model in Nightshift's settings: the deep lane (Nemotron Ultra) serves the
    // Judge, and `npm run meterless:check` checks that the fast lane (Nemotron Lightning) answers too.
    routes: { fast: "meterless/fast", deep: "meterless/deep" },
  },
  pipeline: {
    // Technical Execution Guide, section 5: a full run should take 5-10 minutes. A Judge call takes up to a
    // minute; four at a time, NVIDIA's rate limit refused Ultra calls even after the retries, so two at a time.
    concurrency: 2,
  },
  decision: {
    // Day 4 check-in deck: the Judge scores each verdict 0-3 on accuracy, appropriateness and actionability,
    // and a verdict below 7 of 9 goes to the analyst.
    minJudgeScore: 7,
    maxJudgeScore: 9,
    // Our choice: a Judge reply without a complete verdict is asked for once more, then surfaces.
    judgeAttempts: 2,
  },
  ruleSmith: {
    // Our choice: a rule is back-tested once it held for 3 verdicts in one cluster H-MEM dreamt, so a pair of
    // coincidences cannot raise it, and promoted only if the Judge never contradicted it.
    minSupport: 3,
  },
} as const;
