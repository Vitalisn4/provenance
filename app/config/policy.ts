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
} as const;
