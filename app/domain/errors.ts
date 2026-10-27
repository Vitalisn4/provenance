export type ErrorType = "config" | "input" | "zetaris" | "meterless";

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

export function errorText(error: AppError): string {
  return `${error.type} error: ${error.message}`;
}
