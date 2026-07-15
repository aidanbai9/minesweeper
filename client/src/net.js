import { WS_BASE } from "./config.js";

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

function buildRoomUrl(code, config, includeConfig) {
  const url = new URL(`${WS_BASE}/room/${code}`);
  if (includeConfig && config) {
    url.searchParams.set("w", config.w);
    url.searchParams.set("h", config.h);
    url.searchParams.set("m", config.mineCount);
    if (config.noGuess === true) {
      url.searchParams.set("ng", "1");
    }
  }
  return url.toString();
}

export function createNetTransport({ code, config, name = "Player", token = "" }) {
  const emitter = makeEmitter();
  let ws = null;
  let closed = false;
  let connectedOnce = false;
  let attempt = 0;
  let reconnectTimer = 0;
  let outbox = [];
  let displayName = name;
  let pendingRename = false;

  function emitConnection(reconnecting) {
    emitter.emit("connection", { reconnecting });
  }

  function sendRaw(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ v: 1, ...message }));
      return true;
    }
    return false;
  }

  function open() {
    clearTimeout(reconnectTimer);
    ws = new WebSocket(buildRoomUrl(code, config, !connectedOnce));

    ws.addEventListener("open", () => {
      attempt = 0;
      connectedOnce = true;
      emitConnection(false);
      sendRaw({ t: "HELLO", name: displayName, token });
      if (pendingRename) {
        pendingRename = false;
        sendRaw({ t: "RENAME", name: displayName });
      }
      for (const message of outbox) {
        sendRaw(message);
      }
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.t === "SNAPSHOT") {
        outbox = [];
        emitter.emit("snapshot", message);
      } else if (message.t === "EVENTS") {
        outbox = [];
        emitter.emit("events", { seq: message.seq, events: message.events || [] });
      } else if (message.t === "PEER_JOIN") {
        emitter.emit("peer_join", message.peer);
      } else if (message.t === "PEER_RENAME") {
        emitter.emit("peer_rename", { playerId: message.playerId, name: message.name });
      } else if (message.t === "PEER_LEAVE") {
        emitter.emit("peer_leave", message.playerId);
      } else if (message.t === "CURSOR") {
        emitter.emit("cursor", { playerId: message.playerId, idx: message.idx });
      } else if (message.t === "CHAT") {
        emitter.emit("chat", {
          playerId: message.playerId,
          name: message.name,
          color: message.color,
          text: message.text,
          ts: message.ts
        });
      } else if (message.t === "NOTICE") {
        emitter.emit("notice", message.text);
      } else if (message.t === "WIN_RECORDED") {
        emitter.emit("win_recorded", { t: message.t, rank: message.rank });
      } else if (message.t === "WIN_INELIGIBLE") {
        emitter.emit("win_ineligible", { t: message.t, reason: message.reason });
      } else if (message.t === "ERROR") {
        emitter.emit("error", message);
      }
    });

    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", scheduleReconnect);
  }

  function scheduleReconnect() {
    if (closed) {
      return;
    }
    emitConnection(true);
    clearTimeout(reconnectTimer);
    const delay = Math.min(30000, 500 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(open, delay);
  }

  return {
    connect() {
      closed = false;
      open();
    },
    send(action) {
      if (action.type === "CURSOR") {
        sendRaw({ t: "CURSOR", idx: action.idx });
        return;
      }
      const payload = { type: action.type, idx: action.idx };
      if (action.assist) {
        payload.assist = action.assist;
      }
      if (action.noGuessSeed) {
        payload.noGuessSeed = action.noGuessSeed;
      }
      const message = { t: "ACTION", seq: action.seq, action: payload };
      outbox.push(message);
      if (outbox.length > 100) {
        outbox = outbox.slice(-100);
      }
      sendRaw(message);
    },
    on: emitter.on,
    reset() {
      outbox = [];
      sendRaw({ t: "RESET" });
    },
    reconfig(config) {
      outbox = [];
      sendRaw({ t: "RECONFIG", config: { w: config.w, h: config.h, mineCount: config.mineCount } });
    },
    rename(name) {
      displayName = name;
      pendingRename = !sendRaw({ t: "RENAME", name });
    },
    sendChat(text) {
      sendRaw({ t: "CHAT", text });
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.close(1000, "closed");
      }
    }
  };
}
