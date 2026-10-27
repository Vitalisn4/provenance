import { AppError, errorText } from "../domain/errors.ts";

export async function runCli(main: (args: string[]) => void | Promise<void>): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof AppError ? errorText(error) : error);
    process.exitCode = 1;
  }
}
