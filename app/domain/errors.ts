type ErrorType = "config" | "zetaris";

export class AppError extends Error {
  constructor(
    readonly type: ErrorType,
    message: string,
    readonly recoverable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
