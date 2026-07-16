import { describe, expect, it } from "vitest";
import { PRESETS, generateNoGuess, tankSolves } from "../src/index.js";

function countMines(layout) {
  return layout.mines.reduce((sum, value) => sum + value, 0);
}

describe("generateNoGuess", () => {
  it("returns a deterministic solving layout with first-click zero opening", () => {
    const config = PRESETS.expert;
    const safeIdx = 240;
    const opts = { componentCap: 32, maxAttempts: 500 };

    const first = generateNoGuess("gen-test", config.w, config.h, config.mineCount, safeIdx, opts);
    const second = generateNoGuess("gen-test", config.w, config.h, config.mineCount, safeIdx, opts);

    expect(first.failed).toBeUndefined();
    expect(second.failed).toBeUndefined();
    expect(first.seed).toBe(second.seed);
    expect(Array.from(first.layout.mines)).toEqual(Array.from(second.layout.mines));
    expect(countMines(first.layout)).toBe(config.mineCount);
    expect(first.layout.counts[safeIdx]).toBe(0);
    expect(tankSolves(first.layout, safeIdx, opts).solved).toBe(true);
  });

  it("fails cleanly within maxAttempts when the capped search finds no board", () => {
    const config = PRESETS.expert;
    const result = generateNoGuess("capped", config.w, config.h, config.mineCount, 0, {
      componentCap: 4,
      maxAttempts: 1
    });
    expect(result).toEqual({ failed: true, reason: "no_solvable_board" });
  });
});
