import { describe, expect, it } from "vitest";
import { PRESETS, generateNoGuess, solves } from "../src/index.js";

function countMines(layout) {
  return layout.mines.reduce((sum, value) => sum + value, 0);
}

describe("generateNoGuess", () => {
  it("returns a deterministic solving layout with first-click zero opening", () => {
    const config = PRESETS.beginner;
    const safeIdx = 40;
    const opts = { maxDepth: 4, maxWidth: 6, maxAttempts: 5 };

    const first = generateNoGuess("gen-test", config.w, config.h, config.mineCount, safeIdx, opts);
    const second = generateNoGuess("gen-test", config.w, config.h, config.mineCount, safeIdx, opts);

    expect(first.failed).toBeUndefined();
    expect(second.failed).toBeUndefined();
    expect(first.seed).toBe(second.seed);
    expect(Array.from(first.layout.mines)).toEqual(Array.from(second.layout.mines));
    expect(countMines(first.layout)).toBe(config.mineCount);
    expect(first.layout.counts[safeIdx]).toBe(0);
    expect(solves(first.layout, safeIdx, config, opts)).toBe(true);
  });

  it("fails cleanly within maxAttempts when the capped search finds no board", () => {
    const config = PRESETS.expert;
    const result = generateNoGuess("capped", config.w, config.h, config.mineCount, 0, {
      maxDepth: 4,
      maxWidth: 4,
      maxAttempts: 1
    });
    expect(result).toEqual({ failed: true, reason: "no_solvable_board" });
  });
});
