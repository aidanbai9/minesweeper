import { describe, expect, it } from "vitest";
import { generateBoard, InvalidBoardConfigError, PRESETS, makeRng, neighbors } from "../src/index.js";

function mineTotal(board) {
  return board.mines.reduce((sum, value) => sum + value, 0);
}

describe("generateBoard", () => {
  it("is byte-identical for the same seed and safeIdx across 100 configs", () => {
    const rng = makeRng("configs");

    for (let i = 0; i < 100; i += 1) {
      const w = 5 + rng.nextInt(56);
      const h = 5 + rng.nextInt(56);
      const mineCount = 1 + rng.nextInt(w * h - 9);
      const safeIdx = rng.nextInt(w * h);
      const seed = `seed-${i}-${rng.next()}`;

      const a = generateBoard(seed, w, h, mineCount, safeIdx);
      const b = generateBoard(seed, w, h, mineCount, safeIdx);

      expect(Array.from(a.mines)).toEqual(Array.from(b.mines));
      expect(Array.from(a.counts)).toEqual(Array.from(b.counts));
    }
  });

  it("keeps safeIdx and neighbours mine-free and makes safeIdx a zero", () => {
    const board = generateBoard("safe", 9, 9, 10, 40);
    const protectedCells = [40, ...neighbors(40, 9, 9)];

    for (const idx of protectedCells) {
      expect(board.mines[idx]).toBe(0);
    }
    expect(board.counts[40]).toBe(0);
  });

  it("places the exact mine count for presets and random custom configs", () => {
    for (const preset of Object.values(PRESETS)) {
      const board = generateBoard("preset", preset.w, preset.h, preset.mineCount, 0);
      expect(mineTotal(board)).toBe(preset.mineCount);
    }

    const rng = makeRng("mine-counts");
    for (let i = 0; i < 50; i += 1) {
      const w = 5 + rng.nextInt(56);
      const h = 5 + rng.nextInt(56);
      const mineCount = 1 + rng.nextInt(w * h - 9);
      const board = generateBoard(`custom-${i}`, w, h, mineCount, rng.nextInt(w * h));
      expect(mineTotal(board)).toBe(mineCount);
    }
  });

  it("rejects impossible first-click-safe configs with a typed error", () => {
    expect(() => generateBoard("bad", 5, 5, 17, 12)).toThrow(InvalidBoardConfigError);
  });
});
