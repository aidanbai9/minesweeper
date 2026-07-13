import { describe, expect, it } from "vitest";
import {
  AUTO_FLAG,
  PRESETS,
  Status,
  applyAction,
  assertConfig,
  createGame,
  floodOpen,
  generateBoard,
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
    lostAt: -1,
    assistTainted: false,
    contributors: []
  };
}

function snapshotArrays(state) {
  return {
    revealed: Array.from(state.revealed),
    flags: Array.from(state.flags),
    flagCount: state.flagCount,
    revealedCount: state.revealedCount,
    status: state.status,
    assistTainted: state.assistTainted,
    contributors: state.contributors
  };
}

function cloneStateForTest(state) {
  return {
    ...state,
    board: state.board,
    revealed: new Uint8Array(state.revealed),
    flags: new Uint8Array(state.flags)
  };
}

function slowMineList(board) {
  const mines = [];
  for (let idx = 0; idx < board.mines.length; idx += 1) {
    if (board.mines[idx]) {
      mines.push(idx);
    }
  }
  return mines;
}

function slowWrongFlags(state) {
  const wrong = [];
  for (let idx = 0; idx < state.flags.length; idx += 1) {
    if (state.flags[idx] && !state.board.mines[idx]) {
      wrong.push(idx);
    }
  }
  return wrong;
}

function slowFinishIfWon(state, now) {
  if (state.revealedCount !== state.w * state.h - state.mineCount) {
    return null;
  }
  state.status = Status.WON;
  state.endedAt = now;
  for (let idx = 0; idx < state.board.mines.length; idx += 1) {
    if (state.board.mines[idx] && !state.flags[idx]) {
      state.flags[idx] = AUTO_FLAG;
      state.flagCount += 1;
    }
  }
  return { t: "WIN", endedAt: now, mines: slowMineList(state.board) };
}

function slowNeighborStats(state, idx) {
  let flagged = 0;
  const covered = [];
  for (const n of neighbors(idx, state.w, state.h)) {
    if (state.revealed[n]) {
      continue;
    }
    if (state.flags[n]) {
      flagged += 1;
    } else {
      covered.push(n);
    }
  }
  return { flagged, covered };
}

function slowChord(state, idx, now) {
  const around = neighbors(idx, state.w, state.h);
  let flagged = 0;
  for (const n of around) {
    if (state.flags[n]) {
      flagged += 1;
    }
  }
  if (flagged !== state.board.counts[idx]) {
    return [];
  }

  const events = [];
  const opened = [];
  let detonated = -1;
  for (const n of around) {
    if (state.revealed[n] || state.flags[n]) {
      continue;
    }
    if (state.board.mines[n]) {
      detonated = n;
      continue;
    }
    const cells = floodOpen(state.board, n, state.revealed, state.flags);
    for (const cell of cells) {
      if (!state.revealed[cell]) {
        opened.push(cell);
      }
    }
    for (const cell of cells) {
      state.revealed[cell] = 1;
    }
  }

  if (opened.length > 0) {
    const cells = [];
    for (const cell of opened) {
      state.revealedCount += 1;
      cells.push({ idx: cell, count: state.board.counts[cell] });
    }
    events.push({ t: "OPEN", cells });
  }
  if (detonated !== -1) {
    state.status = Status.LOST;
    state.lostAt = detonated;
    state.endedAt = now;
    events.push({ t: "BOOM", idx: detonated, mines: slowMineList(state.board), wrongFlags: slowWrongFlags(state) });
  }
  return events;
}

function slowAssistFixpoint(state, assist, playerId, now) {
  const next = cloneStateForTest(state);
  const events = [];
  const maxPasses = Math.max(1, next.w * next.h * 16);
  let changed = true;
  let passes = 0;

  while (changed && next.status === Status.PLAYING) {
    changed = false;
    passes += 1;
    if (passes > maxPasses) {
      throw new Error("slow fixpoint did not converge");
    }

    for (let idx = 0; idx < next.revealed.length && next.status === Status.PLAYING; idx += 1) {
      if (!next.revealed[idx] || next.board.counts[idx] === 0) {
        continue;
      }

      let stats = slowNeighborStats(next, idx);
      if (assist.autoFlag && stats.covered.length > 0 && stats.flagged + stats.covered.length === next.board.counts[idx]) {
        for (const n of stats.covered) {
          if (!next.revealed[n] && !next.flags[n]) {
            next.flags[n] = playerId + 1;
            next.flagCount += 1;
            events.push({ t: "FLAG", idx: n, playerId, on: true });
            changed = true;
          }
        }
        stats = slowNeighborStats(next, idx);
      }

      if (assist.autoChord && stats.covered.length > 0 && stats.flagged === next.board.counts[idx]) {
        const before = next.revealedCount;
        const chordEvents = slowChord(next, idx, now);
        if (chordEvents.length > 0) {
          events.push(...chordEvents);
          changed = true;
        }
        if (next.status !== Status.PLAYING) {
          break;
        }
        if (next.revealedCount !== before) {
          const win = slowFinishIfWon(next, now);
          if (win) {
            events.push(win);
            break;
          }
        }
      }
    }
  }

  return { state: next, events };
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

  it("keeps assist taint sticky until a new game is created", () => {
    const game = createGame({ seed: "taint", w: 9, h: 9, mineCount: 10 });
    expect(game.assistTainted).toBe(false);

    const tainted = applyAction(game, {
      type: "CHORD",
      idx: 0,
      playerId: 0,
      now: 1,
      assist: { autoChord: true, autoFlag: false }
    });
    expect(tainted.events).toEqual([]);
    expect(tainted.state.assistTainted).toBe(true);
    expect(game.assistTainted).toBe(false);

    const clean = applyAction(tainted.state, { type: "FLAG", idx: 0, playerId: 0, now: 2 });
    expect(clean.state.assistTainted).toBe(true);
    expect(createGame({ seed: "reset", w: 9, h: 9, mineCount: 10 }).assistTainted).toBe(false);
  });

  it("adds contributors only for actions that produce board events", () => {
    const board = manualBoard(5, 5, [6, 24]);
    let state = playingState(board);

    const noop = applyAction(state, { type: "CHORD", idx: 0, playerId: 2, playerName: "No Op", now: 1 });
    expect(noop.events).toEqual([]);
    expect(noop.state.contributors).toEqual([]);

    state = applyAction(state, { type: "REVEAL", idx: 0, playerId: 0, playerName: "Ada", now: 2 }).state;
    expect(state.contributors).toEqual([{ playerId: 0, name: "Ada" }]);

    state = applyAction(state, { type: "FLAG", idx: 6, playerId: 1, playerName: "Ben", now: 3 }).state;
    expect(state.contributors).toEqual([
      { playerId: 0, name: "Ada" },
      { playerId: 1, name: "Ben" }
    ]);

    state = applyAction(state, { type: "FLAG", idx: 24, playerId: 0, playerName: "Ada", now: 4 }).state;
    expect(state.contributors).toEqual([
      { playerId: 0, name: "Ada" },
      { playerId: 1, name: "Ben" }
    ]);
  });

  it("validates and generates the zhenghua preset", () => {
    assertConfig(PRESETS.zhenghua);
    const board = generateBoard("zhenghua", PRESETS.zhenghua.w, PRESETS.zhenghua.h, PRESETS.zhenghua.mineCount, 0);
    expect(board.w * board.h).toBe(3306);
    expect(board.mineCount).toBe(666);
    expect(Array.from(board.mines).filter(Boolean)).toHaveLength(666);
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
    expect(won.state.flags[24]).toBe(AUTO_FLAG);
  });

  it("marks win auto-flags as engine-owned without attributing them to the winner", () => {
    const winner = 1;
    const board = manualBoard(5, 5, [0, 24]);
    const ready = playingState(board);
    ready.flags[0] = winner + 1;
    ready.flagCount = 1;
    for (let idx = 1; idx < 23; idx += 1) {
      ready.revealed[idx] = 1;
    }
    ready.revealedCount = 22;

    const won = applyAction(ready, { type: "REVEAL", idx: 23, playerId: winner, now: 7 });

    expect(won.state.status).toBe(Status.WON);
    expect(won.state.flagCount).toBe(board.mineCount);
    expect(won.state.flags[0]).toBe(winner + 1);
    expect(won.state.flags[24]).toBe(AUTO_FLAG);
    expect(
      Array.from(won.state.flags)
        .map((owner, idx) => ({ owner, idx }))
        .filter((flag) => flag.owner === winner + 1)
        .map((flag) => flag.idx)
    ).toEqual([0]);
  });

  it("auto-flags only when covered plus flagged neighbours exactly equals the number", () => {
    const board = manualBoard(5, 5, [1, 5]);
    const forced = playingState(board);
    forced.revealed[0] = 1;
    forced.revealedCount = 1;

    const flagged = applyAction(forced, {
      type: "REVEAL",
      idx: 6,
      playerId: 0,
      now: 8,
      assist: { autoChord: false, autoFlag: true }
    });
    expect(flagged.state.flags[1]).toBe(1);
    expect(flagged.state.flags[5]).toBe(1);

    const ambiguous = playingState(board);
    ambiguous.revealed[0] = 1;
    ambiguous.revealedCount = 1;
    const notFlagged = applyAction(ambiguous, {
      type: "FLAG",
      idx: 6,
      playerId: 0,
      now: 9,
      assist: { autoChord: false, autoFlag: true }
    });
    expect(notFlagged.state.flags[1]).toBe(0);
    expect(notFlagged.state.flags[5]).toBe(0);
    expect(notFlagged.state.flags[6]).toBe(1);
  });

  it("auto-chords only when adjacent flags exactly equal the revealed number", () => {
    const board = manualBoard(5, 5, [6]);
    const satisfied = playingState(board);
    satisfied.revealed[0] = 1;
    satisfied.revealedCount = 1;
    const chorded = applyAction(satisfied, {
      type: "FLAG",
      idx: 6,
      playerId: 0,
      now: 10,
      assist: { autoChord: true, autoFlag: false }
    });
    expect(chorded.state.revealed[1]).toBe(1);
    expect(chorded.state.revealed[5]).toBe(1);

    const noFlags = playingState(board);
    noFlags.revealed[0] = 1;
    noFlags.revealedCount = 1;
    const under = applyAction(noFlags, {
      type: "REVEAL",
      idx: 1,
      playerId: 0,
      now: 11,
      assist: { autoChord: true, autoFlag: false }
    });
    expect(under.state.revealed[5]).toBe(0);

    const twoFlags = playingState(board);
    twoFlags.revealed[0] = 1;
    twoFlags.revealedCount = 1;
    twoFlags.flags[5] = 1;
    twoFlags.flags[6] = 1;
    twoFlags.flagCount = 2;
    const over = applyAction(twoFlags, {
      type: "REVEAL",
      idx: 1,
      playerId: 0,
      now: 12,
      assist: { autoChord: true, autoFlag: false }
    });
    expect(over.state.revealed[5]).toBe(0);
  });

  it("cascades to the same fixpoint as a slow whole-board rescan", () => {
    const board = manualBoard(5, 5, [6]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealed[5] = 1;
    state.revealedCount = 2;
    const action = { type: "REVEAL", idx: 1, playerId: 0, now: 13 };
    const base = applyAction(state, { ...action, assist: { autoChord: false, autoFlag: false } });
    const expected = slowAssistFixpoint(base.state, { autoChord: true, autoFlag: true }, 0, 13);
    expected.state.assistTainted = true;
    const actual = applyAction(state, { ...action, assist: { autoChord: true, autoFlag: true } });

    expect(snapshotArrays(actual.state)).toEqual(snapshotArrays(expected.state));
    expect(actual.state.status).toBe(Status.WON);
    expect(actual.events.some((event) => event.t === "FLAG")).toBe(true);
    expect(actual.events.some((event) => event.t === "OPEN")).toBe(true);
  });

  it("keeps assist absent and explicitly disabled behaviour identical", () => {
    const board = manualBoard(5, 5, [6]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealedCount = 1;
    const action = { type: "REVEAL", idx: 1, playerId: 0, now: 14 };

    const absent = applyAction(state, action);
    const disabled = applyAction(state, { ...action, assist: { autoChord: false, autoFlag: false } });

    expect(disabled.events).toEqual(absent.events);
    expect(snapshotArrays(disabled.state)).toEqual(snapshotArrays(absent.state));
  });

  it("auto-chord detonates on a manually misplaced flag and stops the fixpoint", () => {
    const board = manualBoard(5, 5, [6, 24]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealedCount = 1;
    state.flags[1] = 1;
    state.flagCount = 1;

    const result = applyAction(state, {
      type: "REVEAL",
      idx: 5,
      playerId: 0,
      now: 15,
      assist: { autoChord: true, autoFlag: true }
    });
    const boomIdx = result.events.findIndex((event) => event.t === "BOOM");

    expect(result.state.status).toBe(Status.LOST);
    expect(result.events[boomIdx].idx).toBe(6);
    expect(result.state.revealedCount).toBe(2);
    expect(result.events.slice(boomIdx + 1)).toEqual([]);
  });

  it("fully assisted boards converge without hitting the loop bound", () => {
    const board = manualBoard(5, 5, [6]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealed[5] = 1;
    state.revealedCount = 2;

    expect(() =>
      applyAction(state, {
        type: "REVEAL",
        idx: 1,
        playerId: 0,
        now: 16,
        assist: { autoChord: true, autoFlag: true }
      })
    ).not.toThrow();
  });

  it("never mutates the input state", () => {
    const state = createGame({ seed: "immutable", w: 5, h: 5, mineCount: 1 });
    const before = snapshotArrays(state);
    Object.freeze(state);

    expect(() => applyAction(state, { type: "FLAG", idx: 0, playerId: 0, now: 1 })).not.toThrow();
    expect(snapshotArrays(state)).toEqual(before);
  });
});
