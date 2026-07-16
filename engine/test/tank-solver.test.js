import { describe, expect, it } from "vitest";
import { findTankForcedMoves, floodOpen, generateBoard, makeRng, neighbors, tankSolves } from "../src/index.js";

function manualBoard(w, h, mineIdxs, safeIdx = 0) {
  const mines = new Uint8Array(w * h);
  const counts = new Uint8Array(w * h);
  for (const idx of mineIdxs) {
    mines[idx] = 1;
  }
  for (const idx of mineIdxs) {
    for (const n of neighbors(idx, w, h)) {
      counts[n] += 1;
    }
  }
  return { w, h, mineCount: mineIdxs.length, mines, counts, safeIdx };
}

function knownFrom(board, revealedIdxs, flagIdxs = []) {
  const revealed = new Uint8Array(board.w * board.h);
  const flags = new Uint8Array(board.w * board.h);
  const safe = new Uint8Array(board.w * board.h);
  for (const idx of revealedIdxs) {
    revealed[idx] = 1;
  }
  for (const idx of flagIdxs) {
    flags[idx] = 1;
  }
  return { counts: board.counts, revealed, flags, safe };
}

function firstOpeningKnown(board, safeIdx) {
  const revealed = new Uint8Array(board.w * board.h);
  for (const idx of floodOpen(board, safeIdx, revealed)) {
    revealed[idx] = 1;
  }
  return { counts: board.counts, revealed, flags: new Uint8Array(board.w * board.h), safe: new Uint8Array(board.w * board.h) };
}

describe("tank solver", () => {
  it("does not force a move in a symmetric 50/50", () => {
    const board = manualBoard(2, 2, [0]);
    const known = knownFrom(board, [2, 3]);

    const forced = findTankForcedMoves(known, board, { componentCap: 32 });

    expect(forced.contradiction).toBe(false);
    expect(forced.safe).toEqual([]);
    expect(forced.mines).toEqual([]);
  });

  it("solves a known position using only the global mine-count constraint", () => {
    const board = manualBoard(3, 1, [], 0);
    const known = knownFrom(board, []);

    expect(findTankForcedMoves(known, board, { componentCap: 32 })).toMatchObject({ safe: [0, 1, 2], mines: [] });
    expect(findTankForcedMoves(known, board, { componentCap: 32, useGlobalMineCount: false })).toMatchObject({
      safe: [],
      mines: []
    });
  });

  it("has zero safe/mine mislabels across randomized ground-truth layouts", () => {
    const rng = makeRng("tank-ground-truth");
    let checked = 0;

    for (let i = 0; i < 400; i += 1) {
      const w = 5 + rng.nextInt(8);
      const h = 5 + rng.nextInt(8);
      const mineCount = 3 + rng.nextInt(Math.min(20, w * h - 11));
      const safeIdx = rng.nextInt(w * h);
      const board = generateBoard(`tank-ground-${i}`, w, h, mineCount, safeIdx);
      const known = firstOpeningKnown(board, safeIdx);

      for (let extra = 0; extra < 5; extra += 1) {
        const idx = rng.nextInt(w * h);
        if (!board.mines[idx]) {
          for (const opened of floodOpen(board, idx, known.revealed, known.flags)) {
            known.revealed[opened] = 1;
          }
        }
      }

      const forced = findTankForcedMoves(known, board, { componentCap: 32 });
      expect(forced.contradiction, `contradiction on board ${i}`).toBe(false);
      for (const idx of forced.safe) {
        checked += 1;
        expect(board.mines[idx], `safe ${idx} on board ${i}`).toBe(0);
      }
      for (const idx of forced.mines) {
        checked += 1;
        expect(board.mines[idx], `mine ${idx} on board ${i}`).toBe(1);
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it("is deterministic for repeated calls", () => {
    const board = manualBoard(5, 2, [1, 3]);
    const known = knownFrom(board, [5, 6, 7, 8, 9]);
    const first = findTankForcedMoves(known, board, { componentCap: 32 });

    for (let i = 0; i < 20; i += 1) {
      expect(findTankForcedMoves(known, board, { componentCap: 32 })).toEqual(first);
    }
  });

  it("reports component-cap hits without hanging", () => {
    const w = 34;
    const h = 2;
    const counts = new Uint8Array(w * h);
    const revealed = new Uint8Array(w * h);
    for (let x = 0; x < w; x += 1) {
      counts[w + x] = 1;
      revealed[w + x] = 1;
    }
    const stats = {};
    const forced = findTankForcedMoves(
      { counts, revealed, flags: new Uint8Array(w * h), safe: new Uint8Array(w * h) },
      { w, h, mineCount: 1 },
      { componentCap: 32, stats }
    );

    expect(forced.capped).toBe(true);
    expect(stats.capHits).toBe(1);
  });
});
