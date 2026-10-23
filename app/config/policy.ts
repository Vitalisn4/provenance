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
    // Worksheet section 5: the fast lane (Nemotron Lightning) serves the Scout and Resolver, the deep lane
    // (Nemotron Ultra) the Judge and Rule Smith; each lane is pinned to its model in Nightshift's settings.
    routes: { fast: "meterless/fast", deep: "meterless/deep" },
  },
  decision: {
    // Day 4 check-in deck: the Judge scores each verdict 0-3 on accuracy, appropriateness and actionability,
    // and a verdict below 7 of 9 goes to the analyst.
    minJudgeScore: 7,
    maxJudgeScore: 9,
  },
} as const;
