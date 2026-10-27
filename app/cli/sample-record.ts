// Records a live run of every ERP supplier, and of the suppliers typed into input_examples/example_4.json, as
// the sample SAMPLE_MODE replays. With no learning batch, the Judge is asked about every supplier, so a replay
// that learns rules finds every call it still makes. Replies the current sample has for the same requests are
// kept; delete data/sample/recording.json to ask the model afresh. Nothing is written unless every supplier
// succeeded, so the sample never replays an outage.
import { readFileSync } from "node:fs";
import { recordedReplies, recorder, writeRecording } from "../adapters/sample.ts";
import { parseRequest } from "../api/server.ts";
import { openRun } from "../pipeline/run.ts";
import { verify } from "../pipeline/verify.ts";
import { runCli } from "./runCli.ts";

await runCli(async () => {
  const { suppliers } = parseRequest(readFileSync("input_examples/example_4.json", "utf8"));
  const { clients, trace } = openRun({ sample: false, out: process.stderr });
  const { zetaris, chat, recording } = recorder(clients.zetaris, clients.chat, recordedReplies());
  const recorded = { ...clients, zetaris, chat };
  const results = [
    ...(await verify(recorded, trace, [])).suppliers,
    ...(await verify(recorded, trace, [], suppliers)).suppliers,
  ];
  const failed = results.filter((result) => "error" in result).map((result) => result.vendorId);
  if (failed.length > 0) {
    console.error(`Not recorded: ${failed.join(", ")} failed. Run again.`);
    process.exitCode = 1;
    return;
  }
  writeRecording(recording);
  console.error(`Recorded ${results.length} suppliers as the sample`);
});
