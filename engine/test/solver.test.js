import { describe, expect, it } from "vitest";
import {
  Status,
  applyAction,
  findForcedMoves,
  floodOpen,
  generateBoard,
  makeRng,
  neighbors,
  solves
} from "../src/index.js";

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
  for (const idx of revealedIdxs) {
    revealed[idx] = 1;
  }
  for (const idx of flagIdxs) {
    flags[idx] = 1;
  }
  return { counts: board.counts, revealed, flags };
}

function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

function firstOpeningKnown(board, safeIdx) {
  const revealed = new Uint8Array(board.w * board.h);
  for (const idx of floodOpen(board, safeIdx, revealed)) {
    revealed[idx] = 1;
  }
  return { counts: board.counts, revealed, flags: new Uint8Array(board.w * board.h) };
}

function playingStateFromKnown(board, known) {
  return {
    seed: "solver-test",
    w: board.w,
    h: board.h,
    mineCount: board.mineCount,
    status: Status.PLAYING,
    board,
    revealed: new Uint8Array(known.revealed),
    flags: new Uint8Array(known.flags),
    flagCount: known.flags.reduce((sum, value) => sum + (value ? 1 : 0), 0),
    revealedCount: known.revealed.reduce((sum, value) => sum + (value ? 1 : 0), 0),
    startedAt: 1,
    endedAt: 0,
    lostAt: -1,
    assistTainted: false,
    contributors: []
  };
}

describe("findForcedMoves", () => {
  it("deduces the 1-2-1 wall exactly", () => {
    const board = manualBoard(3, 3, [0, 2]);
    const known = knownFrom(board, [3, 4, 5, 6, 7, 8]);

    const forced = findForcedMoves(known, board, { maxDepth: 0, maxWidth: 8 });

    expect(forced).toEqual({ safe: [1], mines: [0, 2] });
  });

  it("does not hallucinate a move in a symmetric 50/50", () => {
    const board = manualBoard(2, 2, [0]);
    const known = knownFrom(board, [2, 3]);

    for (const depth of [0, 1, 2, 3, 4]) {
      expect(findForcedMoves(known, board, { maxDepth: depth, maxWidth: 8 })).toEqual({ safe: [], mines: [] });
      expect(solves(board, 2, board, { maxDepth: depth, maxWidth: 8 })).toBe(false);
    }
  });

  it("uses the global mine count when local rules are stuck", () => {
    const board = manualBoard(3, 3, [1], 7);
    const known = knownFrom(board, [3, 4, 5, 6, 7, 8]);

    expect(findForcedMoves(known, board, { maxDepth: 0, maxWidth: 8, useGlobalMineCount: false })).toEqual({
      safe: [],
      mines: []
    });
    expect(findForcedMoves(known, board, { maxDepth: 0, maxWidth: 8 })).toEqual({ safe: [0, 2], mines: [1] });
    expect(solves(board, 7, board, { maxDepth: 0, maxWidth: 8 })).toBe(true);
    expect(solves(board, 7, board, { maxDepth: 0, maxWidth: 8, useGlobalMineCount: false })).toBe(false);
  });

  it("respects maxWidth for component deductions", () => {
    const board = manualBoard(5, 2, [1, 3]);
    const known = knownFrom(board, [5, 6, 7, 8, 9]);

    expect(findForcedMoves(known, board, { maxDepth: 0, maxWidth: 4 })).toEqual({ safe: [], mines: [] });
    expect(findForcedMoves(known, board, { maxDepth: 0, maxWidth: 5 })).toEqual({ safe: [0, 2, 4], mines: [1, 3] });
  });

  it("finds a deduction at depth 2 but not depth 1", () => {
    const board = manualBoard(3, 3, [0, 1]);
    const known = knownFrom(board, [3, 4]);

    expect(findForcedMoves(known, board, { maxDepth: 1, maxWidth: 8, useGlobalMineCount: false })).toEqual({
      safe: [],
      mines: []
    });
    expect(findForcedMoves(known, board, { maxDepth: 2, maxWidth: 8, useGlobalMineCount: false })).toEqual({
      safe: [2, 5, 8],
      mines: []
    });
  });

  it("finds a deduction at depth 3 but not depth 2", () => {
    const board = manualBoard(4, 3, [0, 2, 6]);
    const known = knownFrom(board, [4, 5, 7]);

    expect(findForcedMoves(known, board, { maxDepth: 2, maxWidth: 14, useGlobalMineCount: false })).toEqual({
      safe: [],
      mines: []
    });
    expect(findForcedMoves(known, board, { maxDepth: 3, maxWidth: 14, useGlobalMineCount: false })).toEqual({
      safe: [3, 11],
      mines: []
    });
  });

  it("is deterministic for repeated calls", () => {
    const board = manualBoard(5, 2, [1, 3]);
    const known = knownFrom(board, [5, 6, 7, 8, 9]);
    const first = findForcedMoves(known, board, { maxDepth: 3, maxWidth: 8 });

    for (let i = 0; i < 20; i += 1) {
      expect(findForcedMoves(known, board, { maxDepth: 3, maxWidth: 8 })).toEqual(first);
    }
  });
});

describe("solver soundness against layouts", () => {
  it("only marks genuine safe cells and genuine mines on random boards", () => {
    const rng = makeRng("solver-soundness");

    for (let i = 0; i < 250; i += 1) {
      const w = 5 + rng.nextInt(5);
      const h = 5 + rng.nextInt(5);
      const mineCount = 3 + rng.nextInt(Math.min(12, w * h - 10));
      const safeIdx = rng.nextInt(w * h);
      const board = generateBoard(`solver-${i}`, w, h, mineCount, safeIdx);
      const known = firstOpeningKnown(board, safeIdx);

      for (let revealAttempts = 0; revealAttempts < 4; revealAttempts += 1) {
        const idx = rng.nextInt(w * h);
        if (!board.mines[idx]) {
          for (const opened of floodOpen(board, idx, known.revealed, known.flags)) {
            known.revealed[opened] = 1;
          }
        }
      }

      const forced = findForcedMoves(known, board, { maxDepth: 2, maxWidth: 10 });
      for (const idx of forced.safe) {
        expect(board.mines[idx], `safe ${idx} on board ${i}`).toBe(0);
      }
      for (const idx of forced.mines) {
        expect(board.mines[idx], `mine ${idx} on board ${i}`).toBe(1);
      }
    }
  });

  it("safe reveals during solving match applyAction open counts", () => {
    const rng = makeRng("solver-apply-action");

    for (let i = 0; i < 60; i += 1) {
      const board = generateBoard(`solver-action-${i}`, 9, 9, 10, rng.nextInt(81));
      const known = firstOpeningKnown(board, board.safeIdx);
      const forced = findForcedMoves(known, board, { maxDepth: 1, maxWidth: 10 });
      const idx = forced.safe.find((cell) => !known.revealed[cell]);
      if (!Number.isInteger(idx)) {
        continue;
      }

      const state = playingStateFromKnown(board, known);
      const { state: next, events } = applyAction(state, { type: "REVEAL", idx, now: 2 });
      const applyCells = events.flatMap((event) => (event.t === "OPEN" ? event.cells : []));
      const expected = floodOpen(board, idx, known.revealed, known.flags).map((cell) => ({
        idx: cell,
        count: board.counts[cell]
      }));

      expect(next.status).not.toBe(Status.LOST);
      expect(sorted(applyCells.map((cell) => cell.idx))).toEqual(sorted(expected.map((cell) => cell.idx)));
      expect(applyCells.map((cell) => [cell.idx, cell.count]).sort()).toEqual(
        expected.map((cell) => [cell.idx, cell.count]).sort()
      );
    }
  });
});

describe("solves", () => {
  it("terminates on expert boards", () => {
    for (let i = 0; i < 10; i += 1) {
      const board = generateBoard(`expert-${i}`, 30, 16, 99, 240);
      expect(() => solves(board, 240, board, { maxDepth: 1, maxWidth: 10 })).not.toThrow();
    }
  });
});
