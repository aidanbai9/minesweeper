import { DurableObject } from "cloudflare:workers";
import { applyAction, createGame, generateBoard, isNoGuessConfig, normalizeConfig, presetKeyForConfig, tankSolves, Status } from "../../engine/src/index.js";
import { cleanName, cleanToken, encode, errorMessage, parseJsonMessage, validateInbound } from "./protocol.js";

const COLORS = ["#0000ff", "#008000", "#800080", "#008080", "#800000", "#000080", "#808000", "#ff7f00"];
const MAX_PLAYERS = 8;
const GC_AFTER_MS = 2 * 60 * 60 * 1000;
const RATE_LIMIT_PER_SEC = 20;
const CHAT_HISTORY_LIMIT = 100;
const CHAT_MAX_LENGTH = 500;
const CHAT_RATE_WINDOW_MS = 5000;
const CHAT_RATE_LIMIT = 5;
const CHAT_COOLDOWN_MS = 5000;
const WIN_INELIGIBLE_REASONS = Object.freeze({ ASSIST: "assist", CUSTOM: "custom" });
const NO_GUESS_SOLVER_OPTS = Object.freeze({ componentCap: 32 });

function arraysToState(data) {
  if (!data) {
    return null;
  }
  const fallbackPlayerId = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
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
    flags: Uint8Array.from(data.flags),
    noGuess: data.noGuess === true,
    assistTainted: data.assistTainted === true,
    contributors: Array.isArray(data.contributors)
      ? data.contributors.map((contributor) => {
          const playerId = fallbackPlayerId(contributor.playerId);
          return {
            playerId,
            name: cleanName(contributor.name) || `Player ${playerId + 1}`,
            token: cleanToken(contributor.token)
          };
        })
      : []
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

function chatRateAllowed(attachment, now) {
  const chatRate = attachment.chatRate || { windowStart: now, count: 0, cooldownUntil: 0 };
  if (chatRate.cooldownUntil > now) {
    attachment.chatRate = chatRate;
    return false;
  }
  if (now - chatRate.windowStart >= CHAT_RATE_WINDOW_MS) {
    chatRate.windowStart = now;
    chatRate.count = 0;
    chatRate.cooldownUntil = 0;
  }
  if (chatRate.count >= CHAT_RATE_LIMIT) {
    chatRate.cooldownUntil = now + CHAT_COOLDOWN_MS;
    attachment.chatRate = chatRate;
    return false;
  }
  chatRate.count += 1;
  attachment.chatRate = chatRate;
  return true;
}

export function cleanChatText(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasWinEvent(events) {
  return events.some((event) => event.t === "WIN");
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

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
    const { state, noGuessRejected } = await this.loadOrCreateState(url);
    const playerId = await this.allocatePlayerId();
    const attachment = {
      playerId,
      name: `Player ${playerId + 1}`,
      token: "",
      color: COLORS[playerId % COLORS.length],
      rate: { second: 0, count: 0 },
      chatRate: { windowStart: 0, count: 0, cooldownUntil: 0 },
      cursor: -1
    };

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    await this.markConnected();
    this.send(server, this.snapshot(state, attachment));
    if (noGuessRejected) {
      this.sendError(server, "noguess_unavailable", "No-guess is currently expert-only");
    }
    this.sendChatHistory(server);
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
      if (message.token) {
        attachment.token = message.token;
      }
      if (message.name) {
        attachment.name = message.name;
        ws.serializeAttachment(attachment);
        this.broadcast({ t: "PEER_JOIN", peer: peerFromAttachment(attachment) });
      } else if (message.token) {
        ws.serializeAttachment(attachment);
      }
      return;
    }

    const now = Date.now();

    if (message.t === "CHAT") {
      this.handleChat(ws, attachment, message.text, now);
      return;
    }

    if (!rateAllowed(attachment, now)) {
      ws.serializeAttachment(attachment);
      return;
    }
    ws.serializeAttachment(attachment);

    if (message.t === "RENAME") {
      await this.renamePlayer(ws, attachment, state, message.name, now);
      return;
    }

    if (message.t === "CURSOR") {
      attachment.cursor = message.idx;
      ws.serializeAttachment(attachment);
      this.broadcast({ t: "CURSOR", playerId: attachment.playerId, idx: message.idx }, ws);
      return;
    }

    if (message.t === "RESET") {
      await this.newGame({ w: state.w, h: state.h, mineCount: state.mineCount, noGuess: state.noGuess === true }, now);
      return;
    }

    if (message.t === "RECONFIG") {
      await this.newGame({ ...message.config, noGuess: message.config.noGuess === true && isNoGuessConfig(message.config) }, now, {
        text: `${attachment.name} started a new ${message.config.w}\u00d7${message.config.h} game`,
        except: ws
      });
      return;
    }

    if (message.action.noGuessSeed && (state.noGuess !== true || !isNoGuessConfig(state))) {
      this.sendError(ws, "noguess_unavailable", "No-guess is currently expert-only");
      return;
    }

    if (state.noGuess === true && state.status === Status.PENDING && message.action.type === "REVEAL") {
      if (!isNoGuessConfig(state)) {
        this.sendError(ws, "noguess_unavailable", "No-guess is currently expert-only");
        return;
      }
      if (!message.action.noGuessSeed) {
        this.sendError(ws, "missing_noguess_seed", "No-guess rooms require a verified first-click seed");
        return;
      }
      const board = generateBoard(message.action.noGuessSeed, state.w, state.h, state.mineCount, message.action.idx);
      if (board.counts[message.action.idx] !== 0) {
        this.sendError(ws, "bad_noguess_seed", "No-guess seed does not solve this board");
        return;
      }
      const verified = tankSolves(board, message.action.idx, NO_GUESS_SOLVER_OPTS);
      if (!verified.solved) {
        this.sendError(ws, "bad_noguess_seed", "No-guess seed does not solve this board");
        return;
      }
    }

    const result = applyAction(state, {
      type: message.action.type,
      idx: message.action.idx,
      noGuessSeed: message.action.noGuessSeed,
      assist: message.action.assist,
      playerId: attachment.playerId,
      playerName: attachment.name,
      playerToken: attachment.token,
      now
    });

    if (result.events.length === 0) {
      if (result.state !== state) {
        await this.saveState(result.state);
        await this.bumpAlarm(now);
      }
      this.send(ws, { t: "EVENTS", seq: message.seq, events: [] });
      return;
    }

    const winOutcome = hasWinEvent(result.events) ? await this.winOutcome(result.state) : null;
    await this.saveState(result.state);
    await this.bumpAlarm(now);
    this.send(ws, { t: "EVENTS", seq: message.seq, events: result.events });
    this.broadcast({ t: "EVENTS", events: result.events }, ws);
    if (winOutcome) {
      this.broadcast(winOutcome);
    }
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
      return { state: existing, noGuessRejected: false };
    }
    const params = url.searchParams;
    const config = normalizeConfig({
      seed: params.get("seed") || randomSeed(),
      w: params.get("w"),
      h: params.get("h"),
      mineCount: params.get("m")
    });
    const requestedNoGuess = params.get("ng") === "1" || params.get("noguess") === "1";
    const noGuessRejected = requestedNoGuess && !isNoGuessConfig(config);
    const state = createGame({ ...config, noGuess: requestedNoGuess && !noGuessRejected });
    await this.saveState(state);
    await this.bumpAlarm(Date.now());
    return { state, noGuessRejected };
  }

  async loadState() {
    return deserializeState(await this.ctx.storage.get("state"));
  }

  async saveState(state) {
    await this.ctx.storage.put("state", serializeState(state));
  }

  async newGame(config, now, notice = null) {
    const next = createGame({
      seed: randomSeed(),
      w: config.w,
      h: config.h,
      mineCount: config.mineCount,
      noGuess: config.noGuess === true
    });
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

  async winOutcome(state) {
    if (state.status !== Status.WON) {
      return null;
    }
    if (state.assistTainted) {
      return { t: "WIN_INELIGIBLE", reason: WIN_INELIGIBLE_REASONS.ASSIST };
    }

    const preset = presetKeyForConfig(state);
    if (!preset) {
      return { t: "WIN_INELIGIBLE", reason: WIN_INELIGIBLE_REASONS.CUSTOM };
    }

    const entry = {
      timeMs: Math.max(0, Math.trunc(state.endedAt - state.startedAt)),
      contributors: (state.contributors || []).map((contributor) => ({
        name: contributor.name,
        token: contributor.token
      })),
      preset,
      mode: state.noGuess === true ? "noguess" : "standard",
      finishedAt: state.endedAt
    };
    const result = await this.env.LEADERBOARD.getByName("global").recordWin(entry);
    return { t: "WIN_RECORDED", ...result };
  }

  async renamePlayer(ws, attachment, state, name, now) {
    attachment.name = name;
    ws.serializeAttachment(attachment);

    let changedState = false;
    if (state.status === Status.PLAYING && Array.isArray(state.contributors)) {
      for (const contributor of state.contributors) {
        const sameToken = attachment.token && contributor.token === attachment.token;
        const sameSocketPlayer = !contributor.token && contributor.playerId === attachment.playerId;
        if (sameToken || sameSocketPlayer) {
          contributor.name = name;
          if (!contributor.token && attachment.token) {
            contributor.token = attachment.token;
          }
          changedState = true;
        }
      }
    }
    if (changedState) {
      await this.saveState(state);
      await this.bumpAlarm(now);
    }

    this.broadcast({ t: "PEER_RENAME", playerId: attachment.playerId, name });
    if (attachment.token) {
      await this.env.LEADERBOARD.getByName("global").renameToken(attachment.token, name);
    }
  }

  handleChat(ws, attachment, rawText, now) {
    const text = cleanChatText(rawText);
    if (!text || text.length > CHAT_MAX_LENGTH) {
      ws.serializeAttachment(attachment);
      return;
    }

    if (!chatRateAllowed(attachment, now)) {
      ws.serializeAttachment(attachment);
      return;
    }

    const message = {
      t: "CHAT",
      playerId: attachment.playerId,
      name: attachment.name,
      color: attachment.color,
      text,
      ts: now
    };
    this.chatHistory().push(message);
    if (this.chat.length > CHAT_HISTORY_LIMIT) {
      this.chat.splice(0, this.chat.length - CHAT_HISTORY_LIMIT);
    }
    ws.serializeAttachment(attachment);
    this.broadcast(message);
  }

  chatHistory() {
    if (!Array.isArray(this.chat)) {
      this.chat = [];
    }
    return this.chat;
  }

  sendChatHistory(ws) {
    for (const message of this.chatHistory()) {
      this.send(ws, message);
    }
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
      config: { seed: state.seed, w: state.w, h: state.h, mineCount: state.mineCount },
      noGuess: state.noGuess === true,
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
