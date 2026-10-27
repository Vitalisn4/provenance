import { describe, expect, it } from "vitest";
import { readRecording, recorder, replayer } from "../../app/adapters/sample.ts";
import { learningBatch, readAnswerKey, score } from "../../app/evaluation/score.ts";
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

  it("keeps the replies an earlier recording has for a request, and asks the model for the rest", async () => {
    const { zetaris, chat } = live();
    const earlier = recorder(zetaris, chat);
    await earlier.chat("deep", user("judge"));

    const again = recorder(zetaris, chat, earlier.recording.nightshift);
    await expect(again.chat("deep", user("judge"))).resolves.toMatchObject({ content: "judge 1" });
    await expect(again.chat("deep", user("judge"))).resolves.toMatchObject({ content: "judge 2" });
    await expect(again.chat("deep", user("other"))).resolves.toMatchObject({ content: "other 3" });
    expect(Object.values(again.recording.nightshift).flat()).toHaveLength(3);
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

  it("replays the recorded demo run offline, learns rules from the learning batch, and decides every supplier as the answer key does", async () => {
    const key = readAnswerKey();
    const { suppliers: results, rules } = await verify(
      { ...replayer(readRecording()), secUserAgent: "Provenance test" },
      testTrace().trace,
      [],
      [],
      learningBatch(key),
    );

    const { suppliers } = score(results, key);
    expect(suppliers.filter((supplier) => !supplier.correct)).toEqual([]);
    expect(suppliers).toHaveLength(Object.keys(key.suppliers).length);
    expect(rules.map(({ id, status }) => `${id} ${status}`)).toEqual([
      "name_is_gleif_legal_name promoted",
      "name_shares_first_word rejected",
      "lei_is_claimed_record promoted",
      "sic_is_listed_edgar_code promoted",
      "sic_missing_from_list promoted",
    ]);
    const settled = results.flatMap((result) =>
      "rules" in result && result.rules.length > 0 ? [result.vendorId] : [],
    );
    expect(settled).toEqual(["V-1003", "V-1006", "V-1007", "V-1015", "V-1016"]);
    expect(settled.every((vendorId) => key.suppliers[vendorId]?.batch === "held_out")).toBe(true);
  });
});
