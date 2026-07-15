import { peerFallbackColor } from "./presence.js";
import { applyAction, createGame, normalizeConfig, Status } from "../engine/index.js";

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

function snapshotFromState(state, you) {
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

export function createLocalTransport(config) {
  const emitter = makeEmitter();
  const you = { playerId: 0, name: "You", color: peerFallbackColor(0) };
  let gameConfig = {
    ...normalizeConfig(config),
    noGuess: config?.noGuess === true,
    noGuessVerified: config?.noGuessVerified === true,
    noGuessSafeIdx: Number.isInteger(config?.noGuessSafeIdx) ? config.noGuessSafeIdx : -1
  };
  let state = createGame(gameConfig);

  return {
    connect() {
      queueMicrotask(() => emitter.emit("snapshot", snapshotFromState(state, you)));
    },
    send(action) {
      if (action.type === "CURSOR") {
        return;
      }
      const result = applyAction(state, { ...action, playerId: 0, now: Date.now() });
      state = result.state;
      if (action.type === "REVEAL" && action.noGuessSeed) {
        gameConfig = {
          ...gameConfig,
          seed: action.noGuessSeed,
          noGuess: true,
          noGuessVerified: true,
          noGuessSafeIdx: action.idx
        };
        updateHash(gameConfig);
      }
      emitter.emit("events", { seq: action.seq, events: result.events });
    },
    on: emitter.on,
    reset() {
      state = createGame(gameConfig);
      emitter.emit("snapshot", snapshotFromState(state, you));
    },
    reconfig(config) {
      gameConfig = {
        ...normalizeConfig({ ...config, seed: randomSeed() }),
        noGuess: config.noGuess === true,
        noGuessVerified: false,
        noGuessSafeIdx: -1
      };
      state = createGame(gameConfig);
      updateHash(gameConfig);
      emitter.emit("snapshot", snapshotFromState(state, you));
    },
    rename(name) {
      you.name = name;
      emitter.emit("peer_rename", { playerId: you.playerId, name });
    },
    close() {}
  };
}
