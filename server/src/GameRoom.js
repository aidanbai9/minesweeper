import { DurableObject } from "cloudflare:workers";
import { applyAction, createGame, normalizeConfig, Status } from "../../engine/src/index.js";
import { cleanName, encode, errorMessage, parseJsonMessage, validateInbound } from "./protocol.js";

const COLORS = ["#0000ff", "#008000", "#800080", "#008080", "#800000", "#000080", "#808000", "#ff7f00"];
const MAX_PLAYERS = 8;
const GC_AFTER_MS = 2 * 60 * 60 * 1000;
const RATE_LIMIT_PER_SEC = 20;

function arraysToState(data) {
  if (!data) {
    return null;
  }
  return {
    ...data,
    board: data.board
      ? {
          ...data.board,
          mines: Uint8Array.from(data.board.mines),
          counts: Uint8Array.from(data.board.counts)
        }
      : null,
    revealed: Uint8Array.from(data.revealed),
    flags: Uint8Array.from(data.flags)
  };
}

export function serializeState(state) {
  return {
    ...state,
    board: state.board
      ? {
          ...state.board,
          mines: Array.from(state.board.mines),
          counts: Array.from(state.board.counts)
        }
      : null,
    revealed: Array.from(state.revealed),
    flags: Array.from(state.flags)
  };
}

export function deserializeState(data) {
  return arraysToState(data);
}

function minesFromState(state) {
  if (!state.board || state.status === Status.PLAYING || state.status === Status.PENDING) {
    return undefined;
  }
  const mines = [];
  for (let idx = 0; idx < state.board.mines.length; idx += 1) {
    if (state.board.mines[idx]) {
      mines.push(idx);
    }
  }
  return mines;
}

function revealedForSnapshot(state) {
  const revealed = [];
  if (!state.board) {
    return revealed;
  }
  for (let idx = 0; idx < state.revealed.length; idx += 1) {
    if (state.revealed[idx]) {
      revealed.push({ idx, count: state.board.counts[idx] });
    }
  }
  return revealed;
}

function flagsForSnapshot(state) {
  const flags = [];
  for (let idx = 0; idx < state.flags.length; idx += 1) {
    if (state.flags[idx]) {
      flags.push({ idx, playerId: state.flags[idx] - 1 });
    }
  }
  return flags;
}

function attachmentOf(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function peerFromAttachment(attachment) {
  return {
    playerId: attachment.playerId,
    name: attachment.name,
    color: attachment.color
  };
}

function randomSeed() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rateAllowed(attachment, now) {
  const second = Math.floor(now / 1000);
  const rate = attachment.rate && attachment.rate.second === second ? attachment.rate : { second, count: 0 };
  if (rate.count >= RATE_LIMIT_PER_SEC) {
    attachment.rate = rate;
    return false;
  }
  rate.count += 1;
  attachment.rate = rate;
  return true;
}

export class GameRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(4008, "room is full");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const url = new URL(request.url);
    const state = await this.loadOrCreateState(url);
    const playerId = await this.allocatePlayerId();
    const attachment = {
      playerId,
      name: `Player ${playerId + 1}`,
      color: COLORS[playerId % COLORS.length],
      rate: { second: 0, count: 0 },
      cursor: -1
    };

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    await this.markConnected();
    this.send(server, this.snapshot(state, attachment));
    this.broadcast({ t: "PEER_JOIN", peer: peerFromAttachment(attachment) }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const attachment = attachmentOf(ws);
    if (!attachment) {
      this.sendError(ws, "missing_session", "Connection identity is missing");
      return;
    }

    const parsed = parseJsonMessage(msg);
    if (!parsed.ok) {
      this.sendError(ws, parsed.code, parsed.message);
      return;
    }

    const state = await this.loadState();
    if (!state) {
      this.sendError(ws, "missing_state", "Room state is missing");
      return;
    }

    const validation = validateInbound(parsed.value, state.w * state.h);
    if (!validation.ok) {
      this.sendError(ws, validation.code, validation.message);
      return;
    }

    const message = validation.value;
    if (message.t === "HELLO") {
      if (message.name) {
        attachment.name = cleanName(message.name) || attachment.name;
        ws.serializeAttachment(attachment);
        this.broadcast({ t: "PEER_JOIN", peer: peerFromAttachment(attachment) });
      }
      return;
    }

    const now = Date.now();
    if (!rateAllowed(attachment, now)) {
      ws.serializeAttachment(attachment);
      return;
    }
    ws.serializeAttachment(attachment);

    if (message.t === "CURSOR") {
      attachment.cursor = message.idx;
      ws.serializeAttachment(attachment);
      this.broadcast({ t: "CURSOR", playerId: attachment.playerId, idx: message.idx }, ws);
      return;
    }

    if (message.t === "RESET") {
      await this.newGame({ w: state.w, h: state.h, mineCount: state.mineCount }, now);
      return;
    }

    if (message.t === "RECONFIG") {
      await this.newGame(message.config, now, {
        text: `${attachment.name} started a new ${message.config.w}\u00d7${message.config.h} game`,
        except: ws
      });
      return;
    }

    const result = applyAction(state, {
      type: message.action.type,
      idx: message.action.idx,
      assist: message.action.assist,
      playerId: attachment.playerId,
      now
    });

    if (result.events.length === 0) {
      this.send(ws, { t: "EVENTS", seq: message.seq, events: [] });
      return;
    }

    await this.saveState(result.state);
    await this.bumpAlarm(now);
    this.send(ws, { t: "EVENTS", seq: message.seq, events: result.events });
    this.broadcast({ t: "EVENTS", events: result.events }, ws);
  }

  async webSocketClose(ws) {
    const attachment = attachmentOf(ws);
    if (attachment) {
      this.broadcast({ t: "PEER_LEAVE", playerId: attachment.playerId }, ws);
    }
    await this.markConnected();
  }

  async webSocketError(ws) {
    const attachment = attachmentOf(ws);
    if (attachment) {
      this.broadcast({ t: "PEER_LEAVE", playerId: attachment.playerId }, ws);
    }
    await this.markConnected();
  }

  async alarm() {
    const lastConnectedAt = (await this.ctx.storage.get("lastConnectedAt")) ?? 0;
    if (Date.now() - lastConnectedAt >= GC_AFTER_MS && this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.bumpAlarm(Date.now());
  }

  async loadOrCreateState(url) {
    const existing = await this.loadState();
    if (existing) {
      return existing;
    }
    const params = url.searchParams;
    const config = normalizeConfig({
      seed: params.get("seed") || randomSeed(),
      w: params.get("w"),
      h: params.get("h"),
      mineCount: params.get("m")
    });
    const state = createGame(config);
    await this.saveState(state);
    await this.bumpAlarm(Date.now());
    return state;
  }

  async loadState() {
    return deserializeState(await this.ctx.storage.get("state"));
  }

  async saveState(state) {
    await this.ctx.storage.put("state", serializeState(state));
  }

  async newGame(config, now, notice = null) {
    const next = createGame({ seed: randomSeed(), w: config.w, h: config.h, mineCount: config.mineCount });
    await this.saveState(next);
    await this.bumpAlarm(now);
    this.broadcastSnapshot(next);
    if (notice) {
      this.broadcast({ t: "NOTICE", text: notice.text }, notice.except);
    }
    return next;
  }

  async allocatePlayerId() {
    const next = (await this.ctx.storage.get("nextPlayerId")) ?? 0;
    await this.ctx.storage.put("nextPlayerId", next + 1);
    return next;
  }

  async markConnected() {
    const now = Date.now();
    await this.ctx.storage.put("lastConnectedAt", now);
    await this.bumpAlarm(now);
  }

  async bumpAlarm(now) {
    await this.ctx.storage.setAlarm(now + GC_AFTER_MS);
  }

  peers(except = null, excludePlayerId = null) {
    const peers = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) {
        continue;
      }
      const attachment = attachmentOf(ws);
      if (attachment && attachment.playerId !== excludePlayerId) {
        peers.push(peerFromAttachment(attachment));
      }
    }
    return peers;
  }

  snapshot(state, attachment) {
    const mines = minesFromState(state);
    const msg = {
      t: "SNAPSHOT",
      you: peerFromAttachment(attachment),
      config: { w: state.w, h: state.h, mineCount: state.mineCount },
      status: state.status,
      revealed: revealedForSnapshot(state),
      flags: flagsForSnapshot(state),
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      lostAt: state.lostAt,
      peers: this.peers(null, attachment.playerId)
    };
    if (mines) {
      msg.mines = mines;
    }
    return msg;
  }

  broadcastSnapshot(state) {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(ws);
      if (attachment) {
        this.send(ws, this.snapshot(state, attachment));
      }
    }
  }

  broadcast(message, except = null) {
    const encoded = encode(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) {
        ws.send(encoded);
      }
    }
  }

  send(ws, message) {
    ws.send(encode(message));
  }

  sendError(ws, code, message) {
    ws.send(errorMessage(code, message));
  }
}
