import { expect } from "vitest";
import { AppError } from "../../app/domain/errors.ts";

// Awaits a promise that must reject with an AppError and returns the error for further checks.
export async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}
