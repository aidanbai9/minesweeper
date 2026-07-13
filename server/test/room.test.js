import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { Status, applyAction, createGame } from "../../engine/src/index.js";
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
});

describe("GameRoom", () => {
  it("lets two sockets in one room see the same board deltas", async () => {
    const code = "abcde234";
    const a = await connect(code, "?seed=same&w=9&h=9&m=10");
    const snapA = await a.next((message) => message.t === "SNAPSHOT");
    const b = await connect(code);
    const snapB = await b.next((message) => message.t === "SNAPSHOT");

    expect(snapA.config).toEqual({ w: 9, h: 9, mineCount: 10 });
    expect(snapB.config).toEqual({ w: 9, h: 9, mineCount: 10 });
    expect(snapA.config.seed).toBeUndefined();

    a.send({ t: "ACTION", action: { type: "REVEAL", idx: 40 } });
    const eventA = await a.next((message) => message.t === "EVENTS");
    const eventB = await b.next((message) => message.t === "EVENTS");

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

    expect(await a.noMessage((message) => message.t === "EVENTS")).toBe(true);
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

    expect(snapA.config).toEqual({ w: 16, h: 16, mineCount: 40 });
    expect(snapB.config).toEqual({ w: 16, h: 16, mineCount: 40 });
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
});
