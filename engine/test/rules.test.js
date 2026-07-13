import { describe, expect, it } from "vitest";
import {
  Status,
  applyAction,
  createGame,
  floodOpen,
  neighbors
} from "../src/index.js";

function manualBoard(w, h, mineIdxs) {
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
  return { w, h, mineCount: mineIdxs.length, mines, counts, safeIdx: -1 };
}

function playingState(board) {
  return {
    seed: "manual",
    w: board.w,
    h: board.h,
    mineCount: board.mineCount,
    status: Status.PLAYING,
    board,
    revealed: new Uint8Array(board.w * board.h),
    flags: new Uint8Array(board.w * board.h),
    flagCount: 0,
    revealedCount: 0,
    startedAt: 1,
    endedAt: 0,
    lostAt: -1
  };
}

function snapshotArrays(state) {
  return {
    revealed: Array.from(state.revealed),
    flags: Array.from(state.flags),
    flagCount: state.flagCount,
    revealedCount: state.revealedCount,
    status: state.status
  };
}

describe("floodOpen", () => {
  it("opens a zero region bounded by numbers without opening mines", () => {
    const board = manualBoard(5, 5, [0]);
    const revealed = new Uint8Array(25);
    const opened = floodOpen(board, 24, revealed);

    expect(opened).toContain(24);
    expect(opened).not.toContain(0);
    expect(opened).toContain(1);
    expect(opened).toContain(5);
    expect(opened.every((idx) => board.mines[idx] === 0)).toBe(true);
  });

  it("does not reveal flagged cells during a flood", () => {
    const board = manualBoard(5, 5, [24]);
    const revealed = new Uint8Array(25);
    const flags = new Uint8Array(25);
    flags[12] = 1;

    const opened = floodOpen(board, 0, revealed, flags);
    expect(opened).not.toContain(12);
  });
});

describe("applyAction", () => {
  it("starts on first reveal, creates a safe board, and opens cells", () => {
    const game = createGame({ seed: "first", w: 9, h: 9, mineCount: 10 });
    const { state, events } = applyAction(game, { type: "REVEAL", idx: 40, playerId: 0, now: 100 });

    expect(state.status).toBe(Status.PLAYING);
    expect(state.startedAt).toBe(100);
    expect(events[0]).toEqual({ t: "START", startedAt: 100 });
    expect(events.some((event) => event.t === "OPEN")).toBe(true);
    expect(state.board.mines[40]).toBe(0);
    expect(state.board.counts[40]).toBe(0);
  });

  it("allows over-flagging so the mine counter can go negative", () => {
    let state = createGame({ seed: "flags", w: 5, h: 5, mineCount: 1 });
    state = applyAction(state, { type: "FLAG", idx: 0, playerId: 0, now: 1 }).state;
    state = applyAction(state, { type: "FLAG", idx: 1, playerId: 0, now: 2 }).state;

    expect(state.flagCount).toBe(2);
    expect(state.mineCount - state.flagCount).toBe(-1);
  });

  it("chord is a no-op unless the flagged neighbour count exactly matches", () => {
    const board = manualBoard(5, 5, [6]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealedCount = 1;

    const mismatch = applyAction(state, { type: "CHORD", idx: 0, playerId: 0, now: 2 });
    expect(mismatch.events).toEqual([]);
    expect(mismatch.state).toBe(state);

    const flagged = playingState(board);
    flagged.revealed[0] = 1;
    flagged.revealedCount = 1;
    flagged.flags[6] = 1;
    flagged.flagCount = 1;

    const match = applyAction(flagged, { type: "CHORD", idx: 0, playerId: 0, now: 3 });
    expect(match.events[0].t).toBe("OPEN");
    expect(match.events[0].cells.map((cell) => cell.idx).sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it("chord can detonate when flags are wrong", () => {
    const board = manualBoard(5, 5, [6]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealedCount = 1;
    state.flags[1] = 1;
    state.flagCount = 1;

    const result = applyAction(state, { type: "CHORD", idx: 0, playerId: 0, now: 4 });
    const boom = result.events.find((event) => event.t === "BOOM");

    expect(result.state.status).toBe(Status.LOST);
    expect(boom.idx).toBe(6);
    expect(boom.mines).toEqual([6]);
    expect(boom.wrongFlags).toEqual([1]);
  });

  it("wins exactly when every non-mine cell is revealed and not before", () => {
    const board = manualBoard(5, 5, [24]);
    const almost = playingState(board);
    for (let idx = 0; idx < 24; idx += 1) {
      if (idx === 18 || idx === 23) {
        continue;
      }
      almost.revealed[idx] = 1;
    }
    almost.revealedCount = 22;

    const notYet = applyAction(almost, { type: "REVEAL", idx: 18, playerId: 0, now: 5 });
    expect(notYet.state.status).toBe(Status.PLAYING);
    expect(notYet.events.some((event) => event.t === "WIN")).toBe(false);

    const ready = playingState(board);
    for (let idx = 0; idx < 23; idx += 1) {
      ready.revealed[idx] = 1;
    }
    ready.revealedCount = 23;

    const won = applyAction(ready, { type: "REVEAL", idx: 23, playerId: 0, now: 6 });
    expect(won.state.status).toBe(Status.WON);
    expect(won.state.endedAt).toBe(6);
    expect(won.events.at(-1)).toEqual({ t: "WIN", endedAt: 6, mines: [24] });
    expect(won.state.flags[24]).toBe(1);
  });

  it("never mutates the input state", () => {
    const state = createGame({ seed: "immutable", w: 5, h: 5, mineCount: 1 });
    const before = snapshotArrays(state);
    Object.freeze(state);

    expect(() => applyAction(state, { type: "FLAG", idx: 0, playerId: 0, now: 1 })).not.toThrow();
    expect(snapshotArrays(state)).toEqual(before);
  });
});
