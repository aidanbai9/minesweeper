import { peerFallbackColor } from "./presence.js";
import { applyAction, createGame, generateBoard, isNoGuessConfig, normalizeConfig, Status } from "../engine/index.js";

const SOLO_PROGRESS_PREFIX = "minesweeper:solo-progress:v1:";
const PLAYED_BOARDS_KEY = "minesweeper:played-boards:v1";
const PLAYED_BOARDS_LIMIT = 200;

function boardId(config) {
  const normalized = normalizeConfig(config);
  return JSON.stringify([
    String(normalized.seed),
    normalized.w,
    normalized.h,
    normalized.mineCount,
    config?.noGuess === true ? 1 : 0
  ]);
}

function progressKey(config) {
  return `${SOLO_PROGRESS_PREFIX}${boardId(config)}`;
}

function readPlayedBoards() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYED_BOARDS_KEY) || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => entry && typeof entry.id === "string" && Number.isFinite(entry.startedAt));
  } catch {
    return [];
  }
}

function writePlayedBoards(entries) {
  try {
    localStorage.setItem(PLAYED_BOARDS_KEY, JSON.stringify(entries.slice(-PLAYED_BOARDS_LIMIT)));
  } catch {}
}

function hasPlayedBoard(config) {
  const id = boardId(config);
  return readPlayedBoards().some((entry) => entry.id === id);
}

function markPlayedBoard(config, startedAt) {
  const id = boardId(config);
  const entries = readPlayedBoards().filter((entry) => entry.id !== id);
  entries.push({ id, seed: String(config.seed), startedAt: Number(startedAt) || Date.now() });
  writePlayedBoards(entries);
}

function numericArray(value, length, max) {
  if (!Array.isArray(value) || value.length !== length) {
    return null;
  }
  const out = new Uint8Array(length);
  for (let idx = 0; idx < length; idx += 1) {
    const n = Number(value[idx]);
    if (!Number.isInteger(n) || n < 0 || n > max) {
      return null;
    }
    out[idx] = n;
  }
  return out;
}

function countNonZero(values) {
  let count = 0;
  for (const value of values) {
    if (value) {
      count += 1;
    }
  }
  return count;
}

function restoreProgress(config) {
  const key = progressKey(config);
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(key) || "null");
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }
  if (!saved || saved.version !== 1) {
    return null;
  }

  const normalized = normalizeConfig(saved);
  const current = normalizeConfig(config);
  const stale =
    normalized.seed !== current.seed ||
    normalized.w !== current.w ||
    normalized.h !== current.h ||
    normalized.mineCount !== current.mineCount ||
    saved.noGuess === true !== (config.noGuess === true);
  if (stale) {
    sessionStorage.removeItem(key);
    return null;
  }

  const total = current.w * current.h;
  const revealed = numericArray(saved.revealed, total, 1);
  const flags = numericArray(saved.flags, total, 255);
  const status = Number(saved.status);
  if (!revealed || !flags || ![Status.PENDING, Status.PLAYING].includes(status)) {
    sessionStorage.removeItem(key);
    return null;
  }

  const state = createGame({ ...current, noGuess: config.noGuess === true });
  state.status = status;
  state.revealed = revealed;
  state.flags = flags;
  state.flagCount = countNonZero(flags);
  state.revealedCount = countNonZero(revealed);
  state.startedAt = Number.isFinite(saved.startedAt) ? Math.max(0, Math.trunc(saved.startedAt)) : 0;
  state.endedAt = Number.isFinite(saved.endedAt) ? Math.max(0, Math.trunc(saved.endedAt)) : 0;
  state.lostAt = Number.isInteger(saved.lostAt) ? saved.lostAt : -1;
  state.assistTainted = saved.assistTainted === true;
  state.leaderboardIneligibleReason =
    typeof saved.leaderboardIneligibleReason === "string" ? saved.leaderboardIneligibleReason : "";

  const firstRevealIdx = Number(saved.firstRevealIdx);
  if (status === Status.PLAYING) {
    if (!Number.isInteger(firstRevealIdx) || firstRevealIdx < 0 || firstRevealIdx >= total || !state.startedAt) {
      sessionStorage.removeItem(key);
      return null;
    }
    state.board = generateBoard(state.seed, state.w, state.h, state.mineCount, firstRevealIdx);
  }

  return {
    state,
    firstRevealIdx: Number.isInteger(firstRevealIdx) ? firstRevealIdx : -1,
    key
  };
}

function saveProgress(state, gameConfig, firstRevealIdx, keyRef) {
  const key = progressKey(gameConfig);
  if (keyRef.current && keyRef.current !== key) {
    sessionStorage.removeItem(keyRef.current);
  }
  keyRef.current = key;

  if (state.status === Status.WON || state.status === Status.LOST) {
    sessionStorage.removeItem(key);
    return;
  }

  const hasProgress = state.status === Status.PLAYING || state.flagCount > 0 || state.assistTainted;
  if (!hasProgress) {
    sessionStorage.removeItem(key);
    return;
  }

  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        seed: state.seed,
        w: state.w,
        h: state.h,
        mineCount: state.mineCount,
        noGuess: state.noGuess === true,
        status: state.status,
        revealed: Array.from(state.revealed),
        flags: Array.from(state.flags),
        startedAt: state.startedAt || 0,
        elapsed: state.startedAt ? Math.max(0, Date.now() - state.startedAt) : 0,
        endedAt: state.endedAt || 0,
        lostAt: state.lostAt ?? -1,
        assistTainted: state.assistTainted === true,
        firstRevealIdx,
        leaderboardIneligibleReason: state.leaderboardIneligibleReason || ""
      })
    );
  } catch {}
}

function clearProgress(keyRef) {
  if (keyRef.current) {
    sessionStorage.removeItem(keyRef.current);
  }
  keyRef.current = "";
}

function makeEmitter() {
  const listeners = new Map();
  return {
    on(event, cb) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event).add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit(event, payload) {
      for (const cb of listeners.get(event) || []) {
        cb(payload);
      }
    }
  };
}

function snapshotFromState(state, you, gameConfig) {
  const revealed = [];
  if (state.board) {
    for (let idx = 0; idx < state.revealed.length; idx += 1) {
      if (state.revealed[idx]) {
        revealed.push({ idx, count: state.board.counts[idx] });
      }
    }
  }

  const flags = [];
  for (let idx = 0; idx < state.flags.length; idx += 1) {
    if (state.flags[idx]) {
      flags.push({ idx, playerId: state.flags[idx] - 1 });
    }
  }

  const msg = {
    t: "SNAPSHOT",
    you,
    config: {
      seed: state.seed,
      w: state.w,
      h: state.h,
      mineCount: state.mineCount,
      noGuessVerified: gameConfig.noGuessVerified === true,
      noGuessSafeIdx: Number.isInteger(gameConfig.noGuessSafeIdx) ? gameConfig.noGuessSafeIdx : -1
    },
    noGuess: state.noGuess === true,
    status: state.status,
    revealed,
    flags,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    lostAt: state.lostAt,
    assistTainted: state.assistTainted === true,
    leaderboardIneligibleReason: state.leaderboardIneligibleReason || "",
    peers: []
  };

  if (state.board && (state.status === Status.WON || state.status === Status.LOST)) {
    msg.mines = [];
    for (let idx = 0; idx < state.board.mines.length; idx += 1) {
      if (state.board.mines[idx]) {
        msg.mines.push(idx);
      }
    }
  }

  return msg;
}

function randomSeed() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
}

function updateHash(config) {
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  params.delete("r");
  params.delete("seed");
  params.set("s", config.seed);
  params.set("w", config.w);
  params.set("h", config.h);
  params.set("m", config.mineCount);
  if (config.noGuess === true) {
    params.set("ng", "1");
  } else {
    params.delete("ng");
  }
  if (config.noGuessVerified === true) {
    params.set("ngv", "1");
    params.set("ngi", String(config.noGuessSafeIdx));
  } else {
    params.delete("ngv");
    params.delete("ngi");
  }
  history.replaceState(null, "", `${location.pathname}${location.search}#${params.toString()}`);
}

export function createLocalTransport(config, options = {}) {
  const emitter = makeEmitter();
  const you = { playerId: 0, name: options.name || "You", color: peerFallbackColor(0) };
  let gameConfig = {
    ...normalizeConfig(config),
    noGuess: config?.noGuess === true && isNoGuessConfig(config),
    noGuessVerified: config?.noGuessVerified === true,
    noGuessSafeIdx: Number.isInteger(config?.noGuessSafeIdx) ? config.noGuessSafeIdx : -1
  };
  const restored = restoreProgress(gameConfig);
  const progressKeyRef = { current: restored?.key || progressKey(gameConfig) };
  let firstRevealIdx = restored?.firstRevealIdx ?? -1;
  let state = restored?.state || createGame(gameConfig);
  if (!restored && hasPlayedBoard(gameConfig)) {
    state.leaderboardIneligibleReason = "replayed_board";
  }

  return {
    connect() {
      queueMicrotask(() => emitter.emit("snapshot", snapshotFromState(state, you, gameConfig)));
    },
    send(action) {
      if (action.type === "CURSOR") {
        return;
      }
      const previousProgressKey = progressKeyRef.current;
      const result = applyAction(state, { ...action, playerId: 0, now: Date.now() });
      state = result.state;
      if (action.type === "REVEAL" && action.noGuessSeed) {
        gameConfig = {
          ...gameConfig,
          seed: action.noGuessSeed,
          noGuess: isNoGuessConfig(gameConfig),
          noGuessVerified: true,
          noGuessSafeIdx: action.idx
        };
        updateHash(gameConfig);
      }
      if (result.events.some((event) => event.t === "START")) {
        firstRevealIdx = action.idx;
        if (!state.leaderboardIneligibleReason && hasPlayedBoard(gameConfig)) {
          state.leaderboardIneligibleReason = "replayed_board";
        }
        markPlayedBoard(gameConfig, state.startedAt);
      }
      if (state.status === Status.WON || state.status === Status.LOST) {
        sessionStorage.removeItem(previousProgressKey);
      }
      saveProgress(state, gameConfig, firstRevealIdx, progressKeyRef);
      emitter.emit("events", {
        seq: action.seq,
        events: result.events,
        assistTainted: state.assistTainted === true,
        leaderboardIneligibleReason: state.leaderboardIneligibleReason || ""
      });
    },
    on: emitter.on,
    reset() {
      clearProgress(progressKeyRef);
      gameConfig = {
        ...gameConfig,
        seed: randomSeed(),
        noGuessVerified: false,
        noGuessSafeIdx: -1
      };
      state = createGame(gameConfig);
      firstRevealIdx = -1;
      state.leaderboardIneligibleReason = hasPlayedBoard(gameConfig) ? "replayed_board" : "";
      progressKeyRef.current = progressKey(gameConfig);
      updateHash(gameConfig);
      emitter.emit("snapshot", snapshotFromState(state, you, gameConfig));
    },
    reconfig(config) {
      clearProgress(progressKeyRef);
      gameConfig = {
        ...normalizeConfig({ ...config, seed: randomSeed() }),
        noGuess: config.noGuess === true && isNoGuessConfig(config),
        noGuessVerified: false,
        noGuessSafeIdx: -1
      };
      state = createGame(gameConfig);
      firstRevealIdx = -1;
      state.leaderboardIneligibleReason = hasPlayedBoard(gameConfig) ? "replayed_board" : "";
      progressKeyRef.current = progressKey(gameConfig);
      updateHash(gameConfig);
      emitter.emit("snapshot", snapshotFromState(state, you, gameConfig));
    },
    rename(name) {
      you.name = name;
      emitter.emit("peer_rename", { playerId: you.playerId, name });
    },
    close() {}
  };
}
