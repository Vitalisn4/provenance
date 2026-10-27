// Records a live run of every supplier as the sample SAMPLE_MODE replays. Nothing is written unless every
// supplier succeeded, so the sample never replays an outage.
import { recorder, writeRecording } from "../adapters/sample.ts";
import { openRun } from "../pipeline/run.ts";
import { verify } from "../pipeline/verify.ts";
import { runCli } from "./runCli.ts";

await runCli(async () => {
  const { clients, trace } = openRun({ sample: false, out: process.stderr });
  const { zetaris, chat, recording } = recorder(clients.zetaris, clients.chat);
  const results = await verify({ ...clients, zetaris, chat }, trace, []);
  const failed = results.filter((result) => "error" in result).map((result) => result.vendorId);
  if (failed.length > 0) {
    console.error(`Not recorded: ${failed.join(", ")} failed. Run again.`);
    process.exitCode = 1;
    return;
  }
  writeRecording(recording);
  console.error(`Recorded ${results.length} suppliers as the sample`);
});
