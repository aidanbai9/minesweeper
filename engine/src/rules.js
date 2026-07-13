import { generateBoard, InvalidBoardConfigError } from "./board.js";
import { floodOpen, neighbors } from "./neighbors.js";

export const Status = Object.freeze({ PENDING: 0, PLAYING: 1, WON: 2, LOST: 3 });

export const PRESETS = Object.freeze({
  beginner: Object.freeze({ w: 9, h: 9, mineCount: 10 }),
  intermediate: Object.freeze({ w: 16, h: 16, mineCount: 40 }),
  expert: Object.freeze({ w: 30, h: 16, mineCount: 99 })
});

export function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, n));
}

export function normalizeConfig(config = {}) {
  const w = clampInt(config.w ?? PRESETS.beginner.w, 5, 60);
  const h = clampInt(config.h ?? PRESETS.beginner.h, 5, 60);
  const maxMines = Math.max(1, w * h - 9);
  const mineCount = clampInt(config.mineCount ?? config.m ?? PRESETS.beginner.mineCount, 1, maxMines);
  const seed = String(config.seed ?? "minesweeper");
  return { seed, w, h, mineCount };
}

export function assertConfig(config) {
  if (!Number.isInteger(config.w) || !Number.isInteger(config.h) || config.w < 5 || config.h < 5) {
    throw new InvalidBoardConfigError("Board dimensions must be at least 5x5");
  }
  if (config.w > 60 || config.h > 60) {
    throw new InvalidBoardConfigError("Board dimensions must be at most 60x60");
  }
  if (!Number.isInteger(config.mineCount) || config.mineCount < 1 || config.mineCount > config.w * config.h - 9) {
    throw new InvalidBoardConfigError("mineCount is outside the valid range");
  }
}

function cloneState(state) {
  return {
    ...state,
    board: state.board,
    revealed: new Uint8Array(state.revealed),
    flags: new Uint8Array(state.flags)
  };
}

function mineList(board) {
  const mines = [];
  for (let idx = 0; idx < board.mines.length; idx += 1) {
    if (board.mines[idx]) {
      mines.push(idx);
    }
  }
  return mines;
}

function wrongFlags(state) {
  const wrong = [];
  for (let idx = 0; idx < state.flags.length; idx += 1) {
    if (state.flags[idx] && !state.board.mines[idx]) {
      wrong.push(idx);
    }
  }
  return wrong;
}

function openCells(next, opened) {
  const cells = [];
  for (const idx of opened) {
    if (!next.revealed[idx]) {
      next.revealed[idx] = 1;
      next.revealedCount += 1;
      cells.push({ idx, count: next.board.counts[idx] });
    }
  }
  return cells;
}

function finishIfWon(next, now, playerId) {
  if (next.revealedCount !== next.w * next.h - next.mineCount) {
    return null;
  }

  next.status = Status.WON;
  next.endedAt = now;
  for (let idx = 0; idx < next.board.mines.length; idx += 1) {
    if (next.board.mines[idx] && !next.flags[idx]) {
      next.flags[idx] = playerId + 1;
      next.flagCount += 1;
    }
  }
  return { t: "WIN", endedAt: now, mines: mineList(next.board) };
}

function boom(next, idx, now) {
  next.status = Status.LOST;
  next.lostAt = idx;
  next.endedAt = now;
  return { t: "BOOM", idx, mines: mineList(next.board), wrongFlags: wrongFlags(next) };
}

export function createGame(config) {
  const normalized = normalizeConfig(config);
  assertConfig(normalized);
  const total = normalized.w * normalized.h;

  return {
    ...normalized,
    status: Status.PENDING,
    board: null,
    revealed: new Uint8Array(total),
    flags: new Uint8Array(total),
    flagCount: 0,
    revealedCount: 0,
    startedAt: 0,
    endedAt: 0,
    lostAt: -1
  };
}

export function applyAction(state, action) {
  const total = state.w * state.h;
  const idx = action?.idx;
  const now = Number(action?.now ?? 0);
  const playerId = Number.isInteger(action?.playerId) && action.playerId >= 0 ? action.playerId : 0;

  if (state.status === Status.WON || state.status === Status.LOST) {
    return { state, events: [] };
  }

  if (action?.type === "FLAG") {
    if (!Number.isInteger(idx) || idx < 0 || idx >= total || state.revealed[idx]) {
      return { state, events: [] };
    }
    const next = cloneState(state);
    const existing = next.flags[idx];
    if (existing) {
      next.flags[idx] = 0;
      next.flagCount -= 1;
      return { state: next, events: [{ t: "FLAG", idx, playerId: existing - 1, on: false }] };
    }
    next.flags[idx] = playerId + 1;
    next.flagCount += 1;
    return { state: next, events: [{ t: "FLAG", idx, playerId, on: true }] };
  }

  if (!Number.isInteger(idx) || idx < 0 || idx >= total || state.flags[idx]) {
    return { state, events: [] };
  }

  if (action?.type === "REVEAL") {
    const next = cloneState(state);
    const events = [];

    if (next.status === Status.PENDING) {
      next.board = generateBoard(next.seed, next.w, next.h, next.mineCount, idx);
      next.status = Status.PLAYING;
      next.startedAt = now;
      events.push({ t: "START", startedAt: now });
    }

    if (next.revealed[idx]) {
      return { state, events: [] };
    }

    if (next.board.mines[idx]) {
      events.push(boom(next, idx, now));
      return { state: next, events };
    }

    const cells = openCells(next, floodOpen(next.board, idx, next.revealed, next.flags));
    if (cells.length > 0) {
      events.push({ t: "OPEN", cells });
    }
    const win = finishIfWon(next, now, playerId);
    if (win) {
      events.push(win);
    }

    return events.length > 0 ? { state: next, events } : { state, events: [] };
  }

  if (action?.type === "CHORD") {
    if (state.status === Status.PENDING || !state.board || !state.revealed[idx] || state.board.counts[idx] === 0) {
      return { state, events: [] };
    }

    const around = neighbors(idx, state.w, state.h);
    let flagged = 0;
    for (const n of around) {
      if (state.flags[n]) {
        flagged += 1;
      }
    }
    if (flagged !== state.board.counts[idx]) {
      return { state, events: [] };
    }

    const next = cloneState(state);
    const events = [];
    const opened = [];
    let detonated = -1;

    for (const n of around) {
      if (next.revealed[n] || next.flags[n]) {
        continue;
      }
      if (next.board.mines[n]) {
        detonated = n;
        continue;
      }
      const cells = floodOpen(next.board, n, next.revealed, next.flags);
      for (const cell of cells) {
        if (!next.revealed[cell]) {
          opened.push(cell);
        }
      }
      for (const cell of cells) {
        next.revealed[cell] = 1;
      }
    }

    if (opened.length > 0) {
      const cells = [];
      for (const cell of opened) {
        next.revealedCount += 1;
        cells.push({ idx: cell, count: next.board.counts[cell] });
      }
      events.push({ t: "OPEN", cells });
    }

    if (detonated !== -1) {
      events.push(boom(next, detonated, now));
      return { state: next, events };
    }

    const win = finishIfWon(next, now, playerId);
    if (win) {
      events.push(win);
    }

    return events.length > 0 ? { state: next, events } : { state, events: [] };
  }

  return { state, events: [] };
}
