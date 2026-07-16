import { generateBoard, InvalidBoardConfigError } from "./board.js";
import { floodOpen, neighbors } from "./neighbors.js";

export const Status = Object.freeze({ PENDING: 0, PLAYING: 1, WON: 2, LOST: 3 });
export const AUTO_FLAG = 255;

export const PRESETS = Object.freeze({
  beginner: Object.freeze({ w: 9, h: 9, mineCount: 10 }),
  intermediate: Object.freeze({ w: 16, h: 16, mineCount: 40 }),
  expert: Object.freeze({ w: 30, h: 16, mineCount: 99 }),
  zhenghua: Object.freeze({ w: 57, h: 58, mineCount: 666 })
});
export const NOGUESS_PRESETS = Object.freeze(["expert"]);

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

export function presetKeyForConfig(config = {}) {
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (preset.w === config.w && preset.h === config.h && preset.mineCount === config.mineCount) {
      return key;
    }
  }
  return "";
}

export function isNoGuessPreset(preset) {
  return NOGUESS_PRESETS.includes(preset);
}

export function isNoGuessConfig(config = {}) {
  return isNoGuessPreset(presetKeyForConfig(config));
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
    flags: new Uint8Array(state.flags),
    contributors: (state.contributors || []).map((contributor) => ({ ...contributor }))
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

function assistEnabled(assist) {
  return Boolean(assist?.autoChord || assist?.autoFlag);
}

function addContributor(next, playerId, name, token) {
  const contributors = next.contributors || (next.contributors = []);
  const existing = contributors.find((contributor) => contributor.playerId === playerId);
  if (existing) {
    if (!existing.token && token) {
      existing.token = token;
    }
    return;
  }
  contributors.push({
    playerId,
    name: typeof name === "string" && name ? name : `Player ${playerId + 1}`,
    token: typeof token === "string" ? token : ""
  });
}

function finishIfWon(next, now) {
  if (next.revealedCount !== next.w * next.h - next.mineCount) {
    return null;
  }

  next.status = Status.WON;
  next.endedAt = now;
  for (let idx = 0; idx < next.board.mines.length; idx += 1) {
    if (next.board.mines[idx] && !next.flags[idx]) {
      next.flags[idx] = AUTO_FLAG;
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

function neighborStats(state, idx) {
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

function applyChordToState(next, idx, now) {
  if (!next.board || !next.revealed[idx] || next.board.counts[idx] === 0) {
    return { changed: false, ended: false, events: [], touched: [] };
  }

  const around = neighbors(idx, next.w, next.h);
  let flagged = 0;
  for (const n of around) {
    if (next.flags[n]) {
      flagged += 1;
    }
  }
  if (flagged !== next.board.counts[idx]) {
    return { changed: false, ended: false, events: [], touched: [] };
  }

  const events = [];
  const touched = [];
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
      touched.push(cell);
    }
    events.push({ t: "OPEN", cells });
  }

  if (detonated !== -1) {
    touched.push(detonated);
    events.push(boom(next, detonated, now));
    return { changed: true, ended: true, events, touched };
  }

  return { changed: events.length > 0, ended: false, events, touched };
}

function insertSorted(queue, idx) {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (queue[mid] < idx) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  queue.splice(lo, 0, idx);
}

function runAssistFixpoint(next, touched, baseIdx, assist, playerId, now) {
  if (!assistEnabled(assist) || next.status !== Status.PLAYING || !next.board) {
    return [];
  }

  const events = [];
  const total = next.w * next.h;
  const queued = new Uint8Array(total);
  const queue = [];

  function enqueue(idx) {
    if (idx < 0 || idx >= total || queued[idx] || !next.revealed[idx] || next.board.counts[idx] === 0) {
      return;
    }
    queued[idx] = 1;
    insertSorted(queue, idx);
  }

  function enqueueAroundChanged(idx) {
    if (next.revealed[idx]) {
      enqueue(idx);
    }
    for (const n of neighbors(idx, next.w, next.h)) {
      if (next.revealed[n]) {
        enqueue(n);
      }
    }
  }

  for (const idx of touched) {
    enqueueAroundChanged(idx);
  }
  if (Number.isInteger(baseIdx) && next.revealed[baseIdx]) {
    enqueue(baseIdx);
  }

  let pops = 0;
  const maxPops = Math.max(1, total * 16);
  while (queue.length > 0 && next.status === Status.PLAYING) {
    pops += 1;
    if (pops > maxPops) {
      throw new Error("Assist fixpoint did not converge");
    }

    const idx = queue.shift();
    queued[idx] = 0;
    if (!next.revealed[idx] || next.board.counts[idx] === 0) {
      continue;
    }

    let stats = neighborStats(next, idx);
    if (assist.autoFlag && stats.covered.length > 0 && stats.flagged + stats.covered.length === next.board.counts[idx]) {
      for (const n of stats.covered) {
        if (next.revealed[n] || next.flags[n]) {
          continue;
        }
        next.flags[n] = playerId + 1;
        next.flagCount += 1;
        events.push({ t: "FLAG", idx: n, playerId, on: true });
        enqueueAroundChanged(n);
      }
      stats = neighborStats(next, idx);
    }

    if (assist.autoChord && stats.covered.length > 0 && stats.flagged === next.board.counts[idx]) {
      const chord = applyChordToState(next, idx, now);
      if (!chord.changed) {
        continue;
      }
      events.push(...chord.events);
      for (const n of chord.touched) {
        enqueueAroundChanged(n);
      }
      if (chord.ended || next.status !== Status.PLAYING) {
        break;
      }
      const win = finishIfWon(next, now);
      if (win) {
        events.push(win);
        break;
      }
    }
  }

  return events;
}

export function createGame(config) {
  const normalized = normalizeConfig(config);
  assertConfig(normalized);
  const total = normalized.w * normalized.h;

  return {
    ...normalized,
    noGuess: config?.noGuess === true && isNoGuessConfig(normalized),
    status: Status.PENDING,
    board: null,
    revealed: new Uint8Array(total),
    flags: new Uint8Array(total),
    flagCount: 0,
    revealedCount: 0,
    startedAt: 0,
    endedAt: 0,
    lostAt: -1,
    assistTainted: false,
    contributors: []
  };
}

function applyFlagAction(state, idx, playerId) {
  const total = state.w * state.h;
  if (!Number.isInteger(idx) || idx < 0 || idx >= total || state.revealed[idx]) {
    return { state, events: [], touched: [] };
  }

  const next = cloneState(state);
  const existing = next.flags[idx];
  if (existing) {
    next.flags[idx] = 0;
    next.flagCount -= 1;
    return { state: next, events: [{ t: "FLAG", idx, playerId: existing - 1, on: false }], touched: [idx] };
  }
  next.flags[idx] = playerId + 1;
  next.flagCount += 1;
  return { state: next, events: [{ t: "FLAG", idx, playerId, on: true }], touched: [idx] };
}

function applyRevealAction(state, idx, playerId, now, noGuessSeed = "") {
  const total = state.w * state.h;
  if (!Number.isInteger(idx) || idx < 0 || idx >= total || state.flags[idx]) {
    return { state, events: [], touched: [] };
  }

  const next = cloneState(state);
  const events = [];
  const touched = [];

  if (next.status === Status.PENDING) {
    next.seed = typeof noGuessSeed === "string" && noGuessSeed ? noGuessSeed : next.seed;
    next.board = generateBoard(next.seed, next.w, next.h, next.mineCount, idx);
    next.status = Status.PLAYING;
    next.startedAt = now;
    events.push({ t: "START", startedAt: now });
  }

  if (next.revealed[idx]) {
    return { state, events: [], touched: [] };
  }

  if (next.board.mines[idx]) {
    events.push(boom(next, idx, now));
    return { state: next, events, touched: [idx] };
  }

  const cells = openCells(next, floodOpen(next.board, idx, next.revealed, next.flags));
  if (cells.length > 0) {
    events.push({ t: "OPEN", cells });
    for (const cell of cells) {
      touched.push(cell.idx);
    }
  }
  const win = finishIfWon(next, now);
  if (win) {
    events.push(win);
  }

  return events.length > 0 ? { state: next, events, touched } : { state, events: [], touched: [] };
}

function applyChordAction(state, idx, now) {
  if (state.status === Status.PENDING || !state.board || !state.revealed[idx] || state.board.counts[idx] === 0) {
    return { state, events: [], touched: [] };
  }

  const next = cloneState(state);
  const chord = applyChordToState(next, idx, now);
  if (!chord.changed) {
    return { state, events: [], touched: [] };
  }

  if (chord.ended) {
    return { state: next, events: chord.events, touched: chord.touched };
  }

  const events = [...chord.events];
  const win = finishIfWon(next, now);
  if (win) {
    events.push(win);
  }

  return events.length > 0 ? { state: next, events, touched: chord.touched } : { state, events: [], touched: [] };
}

export function applyAction(state, action) {
  const idx = action?.idx;
  const now = Number(action?.now ?? 0);
  const playerId = Number.isInteger(action?.playerId) && action.playerId >= 0 ? action.playerId : 0;
  const playerName = typeof action?.playerName === "string" ? action.playerName : "";
  const playerToken = typeof action?.playerToken === "string" ? action.playerToken : "";

  if (state.status === Status.WON || state.status === Status.LOST) {
    return { state, events: [] };
  }

  const enabledAssist = assistEnabled(action?.assist);
  let inputState = state;
  if (enabledAssist && !state.assistTainted) {
    inputState = cloneState(state);
    inputState.assistTainted = true;
  }

  let result;
  if (action?.type === "FLAG") {
    result = applyFlagAction(inputState, idx, playerId);
  } else if (action?.type === "REVEAL") {
    result = applyRevealAction(inputState, idx, playerId, now, action.noGuessSeed);
  } else if (action?.type === "CHORD") {
    result = applyChordAction(inputState, idx, now);
  } else {
    return { state: inputState, events: [] };
  }

  if (result.events.length > 0) {
    addContributor(result.state, playerId, playerName, playerToken);
  }

  if (result.events.length === 0 || result.state.status !== Status.PLAYING || !enabledAssist) {
    return { state: result.state, events: result.events };
  }

  const assistEvents = runAssistFixpoint(result.state, result.touched, idx, action.assist, playerId, now);
  if (assistEvents.length === 0) {
    return { state: result.state, events: result.events };
  }
  return { state: result.state, events: [...result.events, ...assistEvents] };
}
