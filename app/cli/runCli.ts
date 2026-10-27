import { AppError } from "../domain/errors.ts";

export function errorText(error: AppError): string {
  return `${error.type} error: ${error.message}`;
}

export async function runCli(main: (args: string[]) => Promise<void>): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof AppError ? errorText(error) : error);
    process.exitCode = 1;
  }
}
