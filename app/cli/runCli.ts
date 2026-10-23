import { AppError } from "../domain/errors.ts";

export async function runCli(main: (args: string[]) => Promise<void>): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof AppError ? `${error.type} error: ${error.message}` : error);
    process.exitCode = 1;
  }
}
