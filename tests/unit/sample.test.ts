import { describe, expect, it } from "vitest";
import { readRecording, recorder, replayer } from "../../app/adapters/sample.ts";
import { readAnswerKey, score } from "../../app/evaluation/score.ts";
import { verify } from "../../app/pipeline/verify.ts";
import { failure } from "./failure.ts";
import { testTrace } from "./testTrace.ts";

const user = (content: string) => [{ role: "user" as const, content }];

function live() {
  let replies = 0;
  return {
    zetaris: {
      query: (sql: string) => Promise.resolve({ columns: ["sql"], rows: [[sql]] }),
      execute: () => Promise.resolve({ columns: [], rows: [] }),
    },
    chat: (_route: "fast" | "deep", messages: { content: string }[]) =>
      Promise.resolve({ content: `${messages[0]?.content ?? ""} ${++replies}`, model: "nvidia/ultra" }),
  };
}

describe("Sample mode", () => {
  it("replays each recorded answer, and a repeated request's replies in the order given", async () => {
    const { zetaris, chat } = live();
    const recording = recorder(zetaris, chat);
    await recording.zetaris.query("SELECT 1");
    await recording.chat("deep", user("judge"));
    await recording.chat("deep", user("judge"));
    await recording.chat("fast", user("judge"));

    const replay = replayer(JSON.parse(JSON.stringify(recording.recording)) as typeof recording.recording);
    await expect(replay.zetaris.query("SELECT 1")).resolves.toEqual({
      columns: ["sql"],
      rows: [["SELECT 1"]],
    });
    await expect(replay.chat("fast", user("judge"))).resolves.toMatchObject({ content: "judge 3" });
    await expect(replay.chat("deep", user("judge"))).resolves.toEqual({
      content: "judge 1",
      model: "nvidia/ultra",
    });
    await expect(replay.chat("deep", user("judge"))).resolves.toMatchObject({ content: "judge 2" });
  });

  it("refuses a request the recording lacks, and never records a CREATE", async () => {
    const { zetaris, chat } = live();
    const recording = recorder(zetaris, chat);
    expect((await failure(recording.zetaris.execute("CREATE t"))).type).toBe("config");
    await recording.chat("deep", user("judge"));

    const replay = replayer(recording.recording);
    for (const pending of [
      replay.zetaris.query("SELECT 2"),
      replay.zetaris.query("toString"),
      replay.chat("deep", user("other")),
      replay.chat("deep", user("judge")).then(() => replay.chat("deep", user("judge"))),
    ]) {
      expect((await failure(pending)).message).toMatch(
        /^Sample mode replays the recorded demo suppliers only/,
      );
    }
  });

  it("replays the recorded demo run offline and decides every supplier as the answer key does", async () => {
    const results = await verify(
      { ...replayer(readRecording()), secUserAgent: "Provenance test" },
      testTrace().trace,
      [],
    );

    const { suppliers } = score(results, readAnswerKey());
    expect(suppliers.filter((supplier) => !supplier.correct)).toEqual([]);
    expect(suppliers).toHaveLength(Object.keys(readAnswerKey().suppliers).length);
  });
});
