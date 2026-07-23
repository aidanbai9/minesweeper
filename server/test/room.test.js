import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { Status, applyAction, createGame, generateNoGuess, neighbors } from "../../engine/src/index.js";
import { deserializeState, serializeState } from "../src/GameRoom.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function frameHasMines(message) {
  if (Object.prototype.hasOwnProperty.call(message, "mines")) {
    return true;
  }
  return Array.isArray(message.events) && message.events.some((event) => Object.prototype.hasOwnProperty.call(event, "mines"));
}

async function connect(code, query = "") {
  const response = await SELF.fetch(
    new Request(`https://mines.test/room/${code}${query}`, {
      headers: { Upgrade: "websocket" }
    })
  );

  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();

  const ws = response.webSocket;
  const queue = [];
  const waiters = [];
  const history = [];

  function resolveWaiter(message) {
    const idx = waiters.findIndex((waiter) => waiter.predicate(message));
    if (idx === -1) {
      queue.push(message);
      return;
    }
    const [waiter] = waiters.splice(idx, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    history.push(message);
    resolveWaiter(message);
  });
  ws.accept();

  return {
    ws,
    history,
    send(message) {
      ws.send(JSON.stringify({ v: 1, ...message }));
    },
    close() {
      ws.close(1000, "done");
    },
    next(predicate = () => true, timeout = 1000) {
      const idx = queue.findIndex(predicate);
      if (idx !== -1) {
        const [message] = queue.splice(idx, 1);
        return Promise.resolve(message);
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const waiterIdx = waiters.indexOf(waiter);
            if (waiterIdx !== -1) {
              waiters.splice(waiterIdx, 1);
            }
            reject(new Error("Timed out waiting for WebSocket message"));
          }, timeout)
        };
        waiters.push(waiter);
      });
    },
    async noMessage(predicate, timeout = 100) {
      try {
        await this.next(predicate, timeout);
        return false;
      } catch {
        return true;
      }
    }
  };
}

async function storedRoomState(code) {
  const stub = env.GAME.getByName(code);
  return runInDurableObject(stub, async (_instance, state) => state.storage.get("state"));
}

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

async function leaderboardEntries(preset, mode = "standard") {
  const stub = env.LEADERBOARD.getByName("global");
  return (
    (await runInDurableObject(stub, async (_instance, state) => state.storage.get(`lb:${preset}:${mode}`))) || []
  );
}

async function storedRoomKeys(code) {
  const stub = env.GAME.getByName(code);
  return runInDurableObject(stub, async (_instance, state) => [...(await state.storage.list()).keys()]);
}

function presetWinState({ w, h, mineCount, mineStart = 0, startedAt = 1000 }) {
  const mines = Array.from({ length: mineCount }, (_, i) => mineStart + i);
  const board = manualBoard(w, h, mines);
  const state = playingState(board);
  state.startedAt = startedAt;
  let lastSafe = -1;
  for (let idx = 0; idx < w * h; idx += 1) {
    if (board.mines[idx]) {
      continue;
    }
    lastSafe = idx;
  }
  for (let idx = 0; idx < w * h; idx += 1) {
    if (!board.mines[idx] && idx !== lastSafe) {
      state.revealed[idx] = 1;
      state.revealedCount += 1;
    }
  }
  return { state, lastSafe, firstMine: mines[0] };
}

async function setName(socket, name, token = "") {
  socket.send(token ? { t: "HELLO", name, token } : { t: "HELLO", name });
  await socket.next((message) => message.t === "PEER_JOIN" && message.peer?.name === name);
}

async function replaceRoomState(code, state) {
  const stub = env.GAME.getByName(code);
  await runInDurableObject(stub, async (_instance, durableState) => {
    await durableState.storage.put("state", serializeState(state));
  });
}

async function winBeginnerRoom({ code, name, token, startedAt = 1000 }) {
  const socket = await connect(code, `?seed=${code}&w=9&h=9&m=10`);
  await socket.next((message) => message.t === "SNAPSHOT");
  await setName(socket, name, token);

  const { state, lastSafe } = presetWinState({ w: 9, h: 9, mineCount: 10, startedAt });
  await replaceRoomState(code, state);

  socket.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
  await socket.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
  await socket.next((message) => message.t === "WIN_RECORDED");
  return socket;
}

async function winBeginnerRoomWithOutcome({ code, name, token, startedAt }) {
  const socket = await connect(code, `?seed=${code}&w=9&h=9&m=10`);
  await socket.next((message) => message.t === "SNAPSHOT");
  await setName(socket, name, token);

  const { state, lastSafe } = presetWinState({ w: 9, h: 9, mineCount: 10, startedAt });
  await replaceRoomState(code, state);

  socket.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
  await socket.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
  const outcome = await socket.next((message) => message.t === "WIN_RECORDED");
  return { socket, outcome };
}

describe("state serialization", () => {
  it("round-trips typed arrays through plain stored data", () => {
    const start = createGame({ seed: "roundtrip", w: 9, h: 9, mineCount: 10 });
    const { state } = applyAction(start, { type: "REVEAL", idx: 40, playerId: 0, now: 123 });
    const stored = serializeState(state);
    const hydrated = deserializeState(stored);

    expect(Array.isArray(stored.revealed)).toBe(true);
    expect(Array.isArray(stored.board.mines)).toBe(true);
    expect(hydrated.revealed).toBeInstanceOf(Uint8Array);
    expect(hydrated.flags).toBeInstanceOf(Uint8Array);
    expect(hydrated.board.mines).toBeInstanceOf(Uint8Array);
    expect(Array.from(hydrated.revealed)).toEqual(Array.from(state.revealed));
    expect(Array.from(hydrated.board.counts)).toEqual(Array.from(state.board.counts));
  });

  it("round-trips assist taint and contributors", () => {
    const state = createGame({ seed: "tainted", w: 9, h: 9, mineCount: 10 });
    state.assistTainted = true;
    state.contributors = [
      { playerId: 0, name: "Ada", token: "tok-a" },
      { playerId: 2, name: "Ben", token: "tok-b" }
    ];

    const hydrated = deserializeState(serializeState(state));

    expect(hydrated.assistTainted).toBe(true);
    expect(hydrated.contributors).toEqual(state.contributors);
  });
});

describe("GameRoom", () => {
  describe("cursor", () => {
    it("rate-limits cursor broadcasts without starving gameplay actions", async () => {
      const code = "curspres";
      const a = await connect(code, "?seed=cursor&w=9&h=9&m=10");
      const b = await connect(code);
      await a.next((message) => message.t === "SNAPSHOT");
      await b.next((message) => message.t === "SNAPSHOT");

      for (let idx = 0; idx < 25; idx += 1) {
        a.send({ t: "CURSOR", idx });
      }

      const cursors = [];
      for (let i = 0; i < 15; i += 1) {
        cursors.push(await b.next((message) => message.t === "CURSOR"));
      }

      expect(cursors.map((message) => message.idx)).toEqual(Array.from({ length: 15 }, (_, idx) => idx));
      expect(await b.noMessage((message) => message.t === "CURSOR")).toBe(true);

      a.send({ t: "ACTION", seq: 2240, action: { type: "FLAG", idx: 0 } });
      const events = await a.next((message) => message.t === "EVENTS" && message.seq === 2240);
      expect(events.events).toEqual([{ t: "FLAG", idx: 0, playerId: 0, on: true }]);

      a.close();
      b.close();
    });
  });

  describe("chat", () => {
    it("broadcasts server-stamped chat to every socket in the same room", async () => {
      const code = "chat2234";
      const a = await connect(code, "?seed=chat&w=9&h=9&m=10");
      const b = await connect(code);
      await a.next((message) => message.t === "SNAPSHOT");
      await b.next((message) => message.t === "SNAPSHOT");
      await setName(a, "Ada");

      const before = Date.now();
      a.send({ t: "CHAT", text: "hello room", name: "Mallory", color: "#ffffff", playerId: 99, ts: 1 });
      const chatA = await a.next((message) => message.t === "CHAT");
      const chatB = await b.next((message) => message.t === "CHAT");

      expect(chatA).toEqual(chatB);
      expect(chatA).toMatchObject({
        t: "CHAT",
        playerId: 0,
        name: "Ada",
        color: "#0000ff",
        text: "hello room"
      });
      expect(chatA.ts).toBeGreaterThanOrEqual(before);
      expect(chatA.ts).not.toBe(1);
      expect(chatA.name).not.toBe("Mallory");
      expect(chatA.color).not.toBe("#ffffff");

      a.close();
      b.close();
    });

    it("does not broadcast chat across rooms", async () => {
      const a = await connect("chat2235", "?seed=chat&w=9&h=9&m=10");
      const sameRoom = await connect("chat2235");
      const otherRoom = await connect("chat2236", "?seed=other&w=9&h=9&m=10");
      await a.next((message) => message.t === "SNAPSHOT");
      await sameRoom.next((message) => message.t === "SNAPSHOT");
      await otherRoom.next((message) => message.t === "SNAPSHOT");

      a.send({ t: "CHAT", text: "same room only" });
      await sameRoom.next((message) => message.t === "CHAT" && message.text === "same room only");

      expect(await otherRoom.noMessage((message) => message.t === "CHAT")).toBe(true);

      a.close();
      sameRoom.close();
      otherRoom.close();
    });

    it("rejects empty and over-length chat without broadcasting raw text", async () => {
      const code = "chat2237";
      const a = await connect(code, "?seed=chat&w=9&h=9&m=10");
      const b = await connect(code);
      await a.next((message) => message.t === "SNAPSHOT");
      await b.next((message) => message.t === "SNAPSHOT");

      a.send({ t: "CHAT", text: " \n\t " });
      expect(await a.noMessage((message) => message.t === "CHAT")).toBe(true);
      expect(await b.noMessage((message) => message.t === "CHAT")).toBe(true);

      const raw = "x".repeat(600);
      a.send({ t: "CHAT", text: raw });
      expect(await a.noMessage((message) => message.t === "CHAT" && message.text === raw)).toBe(true);
      expect(await b.noMessage((message) => message.t === "CHAT" && message.text === raw)).toBe(true);

      a.close();
      b.close();
    });

    it("cleans control characters and collapses long newline runs", async () => {
      const code = "chat2238";
      const a = await connect(code, "?seed=chat&w=9&h=9&m=10");
      await a.next((message) => message.t === "SNAPSHOT");

      a.send({ t: "CHAT", text: "\u0000one\n\n\n\n\ttwo\u0007" });
      const chat = await a.next((message) => message.t === "CHAT");

      expect(chat.text).toBe("one\n\n\ttwo");

      a.close();
    });

    it("rate-limits chat without disconnecting or broadcasting excess messages", async () => {
      const code = "chat2239";
      const a = await connect(code, "?seed=chat&w=9&h=9&m=10");
      const b = await connect(code);
      await a.next((message) => message.t === "SNAPSHOT");
      await b.next((message) => message.t === "SNAPSHOT");

      for (let i = 0; i < 20; i += 1) {
        a.send({ t: "CHAT", text: `msg ${i}` });
      }

      const received = [];
      for (let i = 0; i < 5; i += 1) {
        received.push(await b.next((message) => message.t === "CHAT"));
      }

      expect(received.map((message) => message.text)).toEqual(["msg 0", "msg 1", "msg 2", "msg 3", "msg 4"]);
      expect(await b.noMessage((message) => message.t === "CHAT")).toBe(true);

      a.send({ t: "ACTION", seq: 123, action: { type: "FLAG", idx: 0 } });
      const events = await a.next((message) => message.t === "EVENTS" && message.seq === 123);
      expect(events.events).toEqual([{ t: "FLAG", idx: 0, playerId: 0, on: true }]);

      a.close();
      b.close();
    });

    it("sends recent chat history after the snapshot to late joiners", async () => {
      const code = "chat2242";
      const a = await connect(code, "?seed=chat&w=9&h=9&m=10");
      await a.next((message) => message.t === "SNAPSHOT");

      a.send({ t: "CHAT", text: "first" });
      await a.next((message) => message.t === "CHAT" && message.text === "first");
      a.send({ t: "CHAT", text: "second" });
      await a.next((message) => message.t === "CHAT" && message.text === "second");

      const late = await connect(code);
      const snapshot = await late.next((message) => message.t === "SNAPSHOT");
      const first = await late.next((message) => message.t === "CHAT");
      const second = await late.next((message) => message.t === "CHAT");

      expect(snapshot.t).toBe("SNAPSHOT");
      expect([first.text, second.text]).toEqual(["first", "second"]);

      a.close();
      late.close();
    });

    it("does not alter game state, persist chat, or touch the leaderboard", async () => {
      const code = "chat2243";
      const a = await connect(code, "?seed=chat&w=9&h=9&m=10");
      await a.next((message) => message.t === "SNAPSHOT");
      const beforeState = await storedRoomState(code);
      const beforeEntries = await leaderboardEntries("beginner");

      a.send({ t: "CHAT", text: "orthogonal" });
      await a.next((message) => message.t === "CHAT" && message.text === "orthogonal");

      expect(await storedRoomState(code)).toEqual(beforeState);
      expect(await leaderboardEntries("beginner")).toEqual(beforeEntries);
      expect(await storedRoomKeys(code)).not.toContain("chat");

      a.close();
    });
  });

  it("lets two sockets in one room see the same board deltas", async () => {
    const code = "abcde234";
    const a = await connect(code, "?seed=same&w=9&h=9&m=10");
    const snapA = await a.next((message) => message.t === "SNAPSHOT");
    const b = await connect(code);
    const snapB = await b.next((message) => message.t === "SNAPSHOT");

    expect(snapA.config).toMatchObject({ w: 9, h: 9, mineCount: 10 });
    expect(snapB.config).toMatchObject({ w: 9, h: 9, mineCount: 10 });
    expect(snapA.config.seed).toBe("same");

    a.send({ t: "ACTION", seq: 11, action: { type: "REVEAL", idx: 40 } });
    const eventA = await a.next((message) => message.t === "EVENTS");
    const eventB = await b.next((message) => message.t === "EVENTS");

    expect(eventA.seq).toBe(11);
    expect(eventB.seq).toBeUndefined();
    expect(eventA.events).toEqual(eventB.events);
    expect(eventA.events.some((event) => event.t === "OPEN")).toBe(true);
    expect(frameHasMines(eventA)).toBe(false);

    a.close();
    b.close();
  });

  it("serializes simultaneous reveals so only one produces broadcast events", async () => {
    const code = "abcde235";
    const a = await connect(code, "?seed=race&w=9&h=9&m=10");
    const b = await connect(code);
    await a.next((message) => message.t === "SNAPSHOT");
    await b.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 40 } });
    b.send({ t: "ACTION", action: { type: "REVEAL", idx: 40 } });

    await a.next((message) => message.t === "EVENTS");
    await b.next((message) => message.t === "EVENTS");

    expect(await a.noMessage((message) => message.t === "EVENTS" && message.events.length > 0)).toBe(true);
    expect(await b.noMessage((message) => message.t === "EVENTS" && message.events.length > 0)).toBe(true);

    a.close();
    b.close();
  });

  it("acks a no-op chord only to the acting socket without changing state", async () => {
    const code = "abcde23n";
    const a = await connect(code, "?seed=noop&w=5&h=5&m=1");
    const b = await connect(code);
    await a.next((message) => message.t === "SNAPSHOT");
    await b.next((message) => message.t === "SNAPSHOT");

    const board = manualBoard(5, 5, [6]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealedCount = 1;
    await replaceRoomState(code, state);
    const before = await storedRoomState(code);

    a.send({ t: "ACTION", seq: 42, action: { type: "CHORD", idx: 0 } });
    const ack = await a.next((message) => message.t === "EVENTS");
    const after = await storedRoomState(code);

    expect(ack.seq).toBe(42);
    expect(ack.events).toEqual([]);
    expect(after).toEqual(before);
    expect(await b.noMessage((message) => message.t === "EVENTS")).toBe(true);

    a.close();
    b.close();
  });

  it("gives a mid-game joiner a snapshot with no mine layout", async () => {
    const code = "abcde236";
    const a = await connect(code, "?seed=join&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 40 } });
    await a.next((message) => message.t === "EVENTS");

    const late = await connect(code);
    const snapshot = await late.next((message) => message.t === "SNAPSHOT");

    expect(snapshot.status).toBe(1);
    expect(snapshot.revealed.length).toBeGreaterThan(0);
    expect(snapshot.mines).toBeUndefined();
    expect(frameHasMines(snapshot)).toBe(false);

    a.close();
    late.close();
  });

  it("sends the mine layout first in BOOM and never before", async () => {
    const code = "abcde237";
    const a = await connect(code, "?seed=boom&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 40 } });
    await a.next((message) => message.t === "EVENTS");

    const stub = env.GAME.getByName(code);
    const mineIdx = await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get("state");
      return stored.board.mines.findIndex((value) => value === 1);
    });

    expect(a.history.some(frameHasMines)).toBe(false);

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: mineIdx } });
    const boomFrame = await a.next((message) => message.t === "EVENTS" && frameHasMines(message));
    const boom = boomFrame.events.find((event) => event.t === "BOOM");

    expect(boom).toBeTruthy();
    expect(boom.idx).toBe(mineIdx);
    expect(boom.mines.length).toBe(10);

    a.close();
  });

  it("verifies a valid no-guess first reveal seed and reports the room mode", async () => {
    const code = "noguesva";
    const a = await connect(code, "?seed=ng&w=30&h=16&m=99&ng=1");
    const snapshot = await a.next((message) => message.t === "SNAPSHOT");
    expect(snapshot.noGuess).toBe(true);

    const found = generateNoGuess("client-ng", 30, 16, 99, 240, { componentCap: 32, maxAttempts: 500 });
    expect(found.failed).toBeUndefined();

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 240, noGuessSeed: found.seed } });
    const events = await a.next((message) => message.t === "EVENTS");
    const stored = await storedRoomState(code);

    expect(events.events.some((event) => event.t === "START")).toBe(true);
    expect(events.events.some((event) => event.t === "OPEN")).toBe(true);
    expect(stored.noGuess).toBe(true);
    expect(stored.seed).toBe(found.seed);
    expect(frameHasMines(events)).toBe(false);

    a.close();
  });

  it("rejects a bogus no-guess seed without starting the game", async () => {
    const code = "noguesvb";
    const a = await connect(code, "?seed=ng&w=30&h=16&m=99&ng=1");
    await a.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 240, noGuessSeed: "bad-0" } });
    const error = await a.next((message) => message.t === "ERROR");
    const stored = await storedRoomState(code);

    expect(error.code).toBe("bad_noguess_seed");
    expect(stored.status).toBe(Status.PENDING);
    expect(stored.board).toBeNull();
    expect(a.history.some(frameHasMines)).toBe(false);

    a.close();
  });

  it("rejects no-guess for non-expert configs", async () => {
    const code = "noguesvd";
    const a = await connect(code, "?seed=ng&w=9&h=9&m=10&ng=1");
    const snapshot = await a.next((message) => message.t === "SNAPSHOT");
    const roomError = await a.next((message) => message.t === "ERROR");

    expect(snapshot.noGuess).toBe(false);
    expect(roomError.code).toBe("noguess_unavailable");

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 40, noGuessSeed: "forced" } });
    const actionError = await a.next((message) => message.t === "ERROR");
    const stored = await storedRoomState(code);

    expect(actionError.code).toBe("noguess_unavailable");
    expect(stored.status).toBe(Status.PENDING);
    expect(stored.board).toBeNull();

    a.close();
  });

  it("restores full state after reconnecting to an idle room", async () => {
    const code = "abcde238";
    const a = await connect(code, "?seed=reconnect&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 40 } });
    const events = await a.next((message) => message.t === "EVENTS");
    const opened = events.events.find((event) => event.t === "OPEN").cells.length;
    a.close();
    await delay(20);

    const again = await connect(code);
    const snapshot = await again.next((message) => message.t === "SNAPSHOT");

    expect(snapshot.status).toBe(1);
    expect(snapshot.revealed.length).toBe(opened);
    expect(snapshot.startedAt).toBeGreaterThan(0);
    expect(snapshot.mines).toBeUndefined();

    again.close();
  });

  it("reconfigures the room for every socket without leaking mines", async () => {
    const code = "abcde24a";
    const a = await connect(code, "?seed=reconfig&w=9&h=9&m=10");
    const b = await connect(code);
    await a.next((message) => message.t === "SNAPSHOT");
    await b.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "RECONFIG", config: { w: 16, h: 16, mineCount: 40 } });
    const snapA = await a.next((message) => message.t === "SNAPSHOT" && message.config.w === 16);
    const snapB = await b.next((message) => message.t === "SNAPSHOT" && message.config.w === 16);
    const noticeB = await b.next((message) => message.t === "NOTICE");

    expect(snapA.config).toMatchObject({ w: 16, h: 16, mineCount: 40 });
    expect(snapB.config).toMatchObject({ w: 16, h: 16, mineCount: 40 });
    expect(snapA.status).toBe(Status.PENDING);
    expect(snapB.status).toBe(Status.PENDING);
    expect(snapA.mines).toBeUndefined();
    expect(snapB.mines).toBeUndefined();
    expect(frameHasMines(snapA)).toBe(false);
    expect(frameHasMines(snapB)).toBe(false);
    expect(noticeB.text).toContain("started a new 16");

    a.close();
    b.close();
  });

  it("keeps no-guess through reset and turns it off when reconfigured away from expert", async () => {
    const code = "noguesvc";
    const a = await connect(code, "?seed=ng&w=30&h=16&m=99&ng=1");
    await a.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "RESET" });
    const reset = await a.next((message) => message.t === "SNAPSHOT");
    expect(reset.noGuess).toBe(true);

    a.send({ t: "RECONFIG", config: { w: 16, h: 16, mineCount: 40, noGuess: true } });
    const reconfig = await a.next((message) => message.t === "SNAPSHOT" && message.config.w === 16);
    expect(reconfig.noGuess).toBe(false);

    a.close();
  });

  it("uses a fresh seed on every reset", async () => {
    const code = "resetnew";
    const a = await connect(code, "?seed=reset-base&w=9&h=9&m=10");
    const initial = await a.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "RESET" });
    const first = await a.next((message) => message.t === "SNAPSHOT");
    a.send({ t: "RESET" });
    const second = await a.next((message) => message.t === "SNAPSHOT");

    expect(first.config.seed).not.toBe(initial.config.seed);
    expect(second.config.seed).not.toBe(first.config.seed);

    a.close();
  });

  it("uses fresh seeds for newly created rooms without explicit seeds", async () => {
    const first = await connect("newseeda", "?w=9&h=9&m=10");
    const second = await connect("newseedb", "?w=9&h=9&m=10");

    const firstSnapshot = await first.next((message) => message.t === "SNAPSHOT");
    const secondSnapshot = await second.next((message) => message.t === "SNAPSHOT");

    expect(firstSnapshot.config.seed).not.toBe(secondSnapshot.config.seed);

    first.close();
    second.close();
  });

  it("rejects impossible reconfig values without closing the socket or changing state", async () => {
    const code = "abcde24b";
    const a = await connect(code, "?seed=badreconfig&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");
    const before = await storedRoomState(code);

    a.send({ t: "RECONFIG", config: { w: 9, h: 9, mineCount: 81 } });
    const error = await a.next((message) => message.t === "ERROR");
    const after = await storedRoomState(code);

    expect(error.code).toBe("bad_config");
    expect(after).toEqual(before);

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 0 } });
    const events = await a.next((message) => message.t === "EVENTS");
    expect(events.events).toEqual([{ t: "FLAG", idx: 0, playerId: 0, on: true }]);

    a.close();
  });

  it("uses a new seed when reconfiguring twice with the same dimensions", async () => {
    const code = "abcde24c";
    const a = await connect(code, "?seed=twice&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");

    async function boardAfterReconfig() {
      a.send({ t: "RECONFIG", config: { w: 9, h: 9, mineCount: 10 } });
      await a.next((message) => message.t === "SNAPSHOT");
      a.send({ t: "ACTION", action: { type: "REVEAL", idx: 40 } });
      await a.next((message) => message.t === "EVENTS");
      const state = await storedRoomState(code);
      return { seed: state.seed, mines: state.board.mines };
    }

    const first = await boardAfterReconfig();
    const second = await boardAfterReconfig();

    expect(first.seed).not.toBe(second.seed);
    expect(first.mines).not.toEqual(second.mines);

    a.close();
  });

  it("returns ERROR for malformed messages and keeps the socket open", async () => {
    const code = "abcde239";
    const a = await connect(code, "?seed=bad&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");

    a.ws.send(JSON.stringify({ v: 2, t: "RESET" }));
    expect((await a.next((message) => message.t === "ERROR")).code).toBe("bad_version");

    a.ws.send(JSON.stringify({ v: 1, t: "NOPE" }));
    expect((await a.next((message) => message.t === "ERROR")).code).toBe("bad_type");

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 999 } });
    expect((await a.next((message) => message.t === "ERROR")).code).toBe("bad_idx");

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 0 } });
    const events = await a.next((message) => message.t === "EVENTS");
    expect(events.events).toEqual([{ t: "FLAG", idx: 0, playerId: 0, on: true }]);

    a.close();
  });

  it("rejects invalid rename without changing the socket name or leaderboard", async () => {
    const code = "badrenam";
    const a = await connect(code, "?seed=badrename&w=9&h=9&m=10");
    const b = await connect(code);
    await a.next((message) => message.t === "SNAPSHOT");
    await b.next((message) => message.t === "SNAPSHOT");
    await setName(a, "Ada", "tok-badrename");
    await setName(b, "Ben", "tok-benrename");

    const lb = env.LEADERBOARD.getByName("global");
    await lb.recordWin({
      timeMs: 1000,
      contributors: [{ name: "Ada", token: "tok-badrename" }],
      preset: "beginner",
      finishedAt: 100000
    });
    const before = await leaderboardEntries("beginner");

    a.send({ t: "RENAME", name: " \u0000\t " });
    const error = await a.next((message) => message.t === "ERROR");

    expect(error.code).toBe("bad_name");
    a.send({ t: "RENAME", name: "a".repeat(30) });
    expect((await a.next((message) => message.t === "ERROR")).code).toBe("bad_name");
    expect(await a.noMessage((message) => message.t === "PEER_RENAME")).toBe(true);
    expect(await leaderboardEntries("beginner")).toEqual(before);

    a.send({ t: "RECONFIG", config: { w: 16, h: 16, mineCount: 40 } });
    await a.next((message) => message.t === "SNAPSHOT" && message.config.w === 16);
    await b.next((message) => message.t === "SNAPSHOT" && message.config.w === 16);
    const notice = await b.next((message) => message.t === "NOTICE");
    expect(notice.text).toContain("Ada started");

    a.close();
    b.close();
  });

  it("broadcasts one assisted cascade as one EVENTS frame", async () => {
    const code = "abcde24d";
    const a = await connect(code, "?seed=assist&w=5&h=5&m=1");
    const b = await connect(code);
    await a.next((message) => message.t === "SNAPSHOT");
    await b.next((message) => message.t === "SNAPSHOT");

    const board = manualBoard(5, 5, [6, 18, 24]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealedCount = 1;
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 6, assist: { autoChord: true, autoFlag: false } } });
    const eventA = await a.next((message) => message.t === "EVENTS");
    const eventB = await b.next((message) => message.t === "EVENTS");

    expect(eventA.events).toEqual(eventB.events);
    expect(eventA.events.filter((event) => event.t === "FLAG")).toHaveLength(1);
    expect(eventA.events.some((event) => event.t === "OPEN")).toBe(true);
    expect(frameHasMines(eventA)).toBe(false);
    expect(await a.noMessage((message) => message.t === "EVENTS")).toBe(true);
    expect(await b.noMessage((message) => message.t === "EVENTS")).toBe(true);

    a.close();
    b.close();
  });

  it("rejects malformed assist payloads without closing the socket", async () => {
    const code = "abcde24e";
    const a = await connect(code, "?seed=badassist&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 0, assist: null } });
    expect((await a.next((message) => message.t === "ERROR")).code).toBe("bad_action");

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 0, assist: { autoChord: true, autoFlag: "yes" } } });
    expect((await a.next((message) => message.t === "ERROR")).code).toBe("bad_action");

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 0, assist: { autoChord: true, autoFlag: false, extra: true } } });
    expect((await a.next((message) => message.t === "ERROR")).code).toBe("bad_action");

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 0, assist: { autoChord: false, autoFlag: false } } });
    const events = await a.next((message) => message.t === "EVENTS");
    expect(events.events).toEqual([{ t: "FLAG", idx: 0, playerId: 0, on: true }]);

    a.close();
  });

  it("keeps mine layout hidden during assisted cascades", async () => {
    const code = "abcde24f";
    const a = await connect(code, "?seed=assistsafe&w=5&h=5&m=1");
    await a.next((message) => message.t === "SNAPSHOT");

    const board = manualBoard(5, 5, [6, 18, 24]);
    const state = playingState(board);
    state.revealed[0] = 1;
    state.revealedCount = 1;
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "FLAG", idx: 6, assist: { autoChord: true, autoFlag: false } } });
    const events = await a.next((message) => message.t === "EVENTS");

    expect(events.events.some((event) => event.t === "OPEN")).toBe(true);
    expect(frameHasMines(events)).toBe(false);

    a.close();
  });

  it("records an expert win with only actual contributors in first-contribution order", async () => {
    const code = "rankwin2";
    const a = await connect(code, "?seed=rank&w=30&h=16&m=99");
    const b = await connect(code);
    const watcher = await connect(code);
    await a.next((message) => message.t === "SNAPSHOT");
    await b.next((message) => message.t === "SNAPSHOT");
    await watcher.next((message) => message.t === "SNAPSHOT");
    await setName(a, "Ada", "tok-a");
    await setName(b, "Ben", "tok-b");
    await setName(watcher, "Watcher", "tok-watcher");

    const { state, lastSafe, firstMine } = presetWinState({ w: 30, h: 16, mineCount: 99 });
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "FLAG", idx: firstMine } });
    await a.next((message) => message.t === "EVENTS");
    await b.next((message) => message.t === "EVENTS");
    a.close();
    await delay(20);

    b.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
    const winFrame = await b.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
    const recorded = await b.next((message) => message.t === "WIN_RECORDED");
    const stored = await storedRoomState(code);
    const entries = await leaderboardEntries("expert");

    expect(winFrame.events.at(-1).t).toBe("WIN");
    expect(recorded.rank).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].timeMs).toBe(stored.endedAt - stored.startedAt);
    expect(entries[0].contributors).toEqual([
      { name: "Ada", token: "tok-a" },
      { name: "Ben", token: "tok-b" }
    ]);
    expect(entries[0].contributors.map((contributor) => contributor.name)).not.toContain("Watcher");

    b.close();
    watcher.close();
  });

  it("records an online solo preset win with one contributor", async () => {
    const a = await winBeginnerRoom({ code: "solorank", name: "Solo", token: "tok-solo" });
    const entries = await leaderboardEntries("beginner");

    expect(entries).toHaveLength(1);
    expect(entries[0].contributors).toEqual([{ name: "Solo", token: "tok-solo" }]);

    a.close();
  });

  it("ignores stale leaderboard opt-out room state and records an eligible preset win", async () => {
    const code = "oldoptout";
    const a = await connect(code, "?seed=oldoptout&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");
    await setName(a, "Legacy", "tok-legacy-optout");

    const { state, lastSafe } = presetWinState({ w: 9, h: 9, mineCount: 10 });
    state.ranked = false;
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
    await a.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
    const recorded = await a.next((message) => message.t === "WIN_RECORDED");
    const entries = await leaderboardEntries("beginner");

    expect(recorded.rank).toBe(1);
    expect(entries).toHaveLength(1);

    a.close();
  });

  it("broadcasts outside_top_50 for an eligible win slower than the board", async () => {
    const lb = env.LEADERBOARD.getByName("global");
    for (let i = 0; i < 50; i += 1) {
      await lb.recordWin({
        timeMs: 1000 + i,
        contributors: [{ name: `Player ${i}`, token: `tok-player-${i}` }],
        preset: "beginner",
        finishedAt: 100000 + i
      });
    }

    const { socket, outcome } = await winBeginnerRoomWithOutcome({
      code: "slowrank",
      name: "Slow",
      token: "tok-slowrank",
      startedAt: Date.now() - 5000
    });

    expect(outcome).toMatchObject({ t: "WIN_RECORDED", ranked: false, reason: "outside_top_50" });
    expect(outcome.cap).toBeUndefined();
    socket.close();
  });

  it("broadcasts outside_personal_best for a globally rankable capped solo win", async () => {
    const lb = env.LEADERBOARD.getByName("global");
    for (let i = 0; i < 6; i += 1) {
      await lb.recordWin({
        timeMs: 1000 + i,
        contributors: [{ name: "Ada", token: `tok-ada-cap-${i}` }],
        preset: "beginner",
        finishedAt: 100000 + i
      });
    }

    const { socket, outcome } = await winBeginnerRoomWithOutcome({
      code: "caprank2",
      name: "Ada",
      token: "tok-ada-cap-slow",
      startedAt: Date.now() - 2000
    });

    expect(outcome).toMatchObject({ t: "WIN_RECORDED", ranked: false, reason: "outside_personal_best", cap: 6 });
    socket.close();
  });

  it("records a no-guess preset win on the no-guess board only", async () => {
    const code = "ngranksa";
    const a = await connect(code, "?seed=rank&w=30&h=16&m=99&ng=1");
    await a.next((message) => message.t === "SNAPSHOT");
    await setName(a, "NoGuess", "tok-ng");

    const { state, lastSafe } = presetWinState({ w: 30, h: 16, mineCount: 99 });
    state.noGuess = true;
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe, noGuessSeed: "ignored-after-start" } });
    await a.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
    await a.next((message) => message.t === "WIN_RECORDED");

    expect(await leaderboardEntries("expert", "standard")).toEqual([]);
    expect(await leaderboardEntries("expert", "noguess")).toHaveLength(1);

    a.close();
  });

  it("does not record an assisted no-guess win on either board", async () => {
    const code = "ngranksb";
    const a = await connect(code, "?seed=rank&w=30&h=16&m=99&ng=1");
    await a.next((message) => message.t === "SNAPSHOT");

    const { state, lastSafe } = presetWinState({ w: 30, h: 16, mineCount: 99 });
    state.noGuess = true;
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "CHORD", idx: 0, assist: { autoChord: true, autoFlag: false } } });
    await a.next((message) => message.t === "EVENTS");
    a.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
    await a.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
    await a.next((message) => message.t === "WIN_INELIGIBLE");

    expect(await leaderboardEntries("expert", "standard")).toEqual([]);
    expect(await leaderboardEntries("expert", "noguess")).toEqual([]);

    a.close();
  });

  it("renames an in-progress contributor before recording the win", async () => {
    const code = "rnmidgam";
    const a = await connect(code, "?seed=renamegame&w=9&h=9&m=10");
    await a.next((message) => message.t === "SNAPSHOT");
    await setName(a, "Ada", "tok-midgame");

    const { state, firstMine, lastSafe } = presetWinState({ w: 9, h: 9, mineCount: 10 });
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "FLAG", idx: firstMine } });
    await a.next((message) => message.t === "EVENTS");
    expect((await storedRoomState(code)).contributors).toEqual([
      { playerId: 0, name: "Ada", token: "tok-midgame" }
    ]);

    a.send({ t: "RENAME", name: "Ada Prime" });
    const rename = await a.next((message) => message.t === "PEER_RENAME");
    expect(rename).toMatchObject({ playerId: 0, name: "Ada Prime" });
    expect((await storedRoomState(code)).contributors).toEqual([
      { playerId: 0, name: "Ada Prime", token: "tok-midgame" }
    ]);

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
    await a.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
    await a.next((message) => message.t === "WIN_RECORDED");
    const entries = await leaderboardEntries("beginner");

    expect(entries).toHaveLength(1);
    expect(entries[0].contributors).toEqual([{ name: "Ada Prime", token: "tok-midgame" }]);

    a.close();
  });

  it("renames prior entries for one session token without touching another identical name", async () => {
    const first = await winBeginnerRoom({ code: "rnpriora", name: "aidan", token: "tok-same", startedAt: 1000 });
    const second = await winBeginnerRoom({ code: "rnpriorb", name: "aidan", token: "tok-same", startedAt: 2000 });
    const other = await winBeginnerRoom({ code: "rnpriorc", name: "aidan", token: "tok-other", startedAt: 3000 });
    const before = await leaderboardEntries("beginner");
    const beforeTiming = before.map((entry) => [entry.timeMs, entry.finishedAt]);

    first.send({ t: "RENAME", name: "Aidan Prime" });
    await first.next((message) => message.t === "PEER_RENAME" && message.name === "Aidan Prime");
    const after = await leaderboardEntries("beginner");

    expect(after.map((entry) => [entry.timeMs, entry.finishedAt])).toEqual(beforeTiming);
    expect(
      after
        .filter((entry) => entry.contributors.some((contributor) => contributor.token === "tok-same"))
        .map((entry) => entry.contributors[0].name)
    ).toEqual(["Aidan Prime", "Aidan Prime"]);
    expect(after.find((entry) => entry.contributors[0].token === "tok-other").contributors[0].name).toBe("aidan");

    first.close();
    second.close();
    other.close();
  });

  it("does not record a win after assist was enabled at any point", async () => {
    const code = "assist25";
    const a = await connect(code, "?seed=assisttaint&w=30&h=16&m=99");
    const b = await connect(code);
    await a.next((message) => message.t === "SNAPSHOT");
    await b.next((message) => message.t === "SNAPSHOT");
    await setName(a, "Ada");
    await setName(b, "Ben");

    const { state, lastSafe } = presetWinState({ w: 30, h: 16, mineCount: 99 });
    await replaceRoomState(code, state);

    a.send({
      t: "ACTION",
      seq: 7,
      action: { type: "CHORD", idx: 0, assist: { autoChord: true, autoFlag: false } }
    });
    const ack = await a.next((message) => message.t === "EVENTS" && message.seq === 7);
    expect(ack.events).toEqual([]);
    expect((await storedRoomState(code)).assistTainted).toBe(true);

    b.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
    await b.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
    const ineligible = await b.next((message) => message.t === "WIN_INELIGIBLE");

    expect(ineligible.reason).toBe("assist");
    expect(await leaderboardEntries("expert")).toEqual([]);

    a.close();
    b.close();
  });

  it("does not record a custom-board win", async () => {
    const code = "custom25";
    const a = await connect(code, "?seed=custom&w=10&h=10&m=15");
    await a.next((message) => message.t === "SNAPSHOT");
    await setName(a, "Custom");

    const { state, lastSafe } = presetWinState({ w: 10, h: 10, mineCount: 15 });
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: lastSafe } });
    await a.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "WIN"));
    const ineligible = await a.next((message) => message.t === "WIN_INELIGIBLE");

    expect(ineligible.reason).toBe("custom");
    expect(await leaderboardEntries("beginner")).toEqual([]);
    expect(await leaderboardEntries("expert")).toEqual([]);

    a.close();
  });

  it("does not record losses", async () => {
    const code = "lossrec2";
    const a = await connect(code, "?seed=loss&w=30&h=16&m=99");
    await a.next((message) => message.t === "SNAPSHOT");
    await setName(a, "Loser");

    const { state, firstMine } = presetWinState({ w: 30, h: 16, mineCount: 99 });
    state.revealed.fill(0);
    state.revealedCount = 0;
    await replaceRoomState(code, state);

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: firstMine } });
    await a.next((message) => message.t === "EVENTS" && message.events.some((event) => event.t === "BOOM"));

    expect(await a.noMessage((message) => message.t === "WIN_RECORDED" || message.t === "WIN_INELIGIBLE")).toBe(true);
    expect(await leaderboardEntries("expert")).toEqual([]);

    a.close();
  });
});
