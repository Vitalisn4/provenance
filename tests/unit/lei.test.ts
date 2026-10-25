import { describe, expect, it } from "vitest";
import { isValidLei } from "../../app/domain/lei.ts";

describe("isValidLei", () => {
  it("checks the ISO 17442 check digits", () => {
    expect(isValidLei("VGRQXHF3J8VDLUA7XE92")).toBe(true);
    expect(isValidLei("VGRQXHF3J8VDLUA7XE93")).toBe(false);
    expect(isValidLei("vgrqxhf3j8vdlua7xe92")).toBe(false);
    expect(isValidLei("VGRQXHF3J8VDLUA7XE9")).toBe(false);
  });
});
