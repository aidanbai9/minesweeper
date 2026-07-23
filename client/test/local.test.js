import { beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "../engine/index.js";
import { createLocalTransport } from "../src/local.js";

class MemoryStorage {
  constructor() {
    this.items = new Map();
  }

  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }

  setItem(key, value) {
    this.items.set(String(key), String(value));
  }

  removeItem(key) {
    this.items.delete(key);
  }

  clear() {
    this.items.clear();
  }
}

function installBrowserGlobals() {
  const location = { pathname: "/", search: "", hash: "" };
  let randomOffset = 0;
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  Object.defineProperty(globalThis, "document", { value: { documentElement: {} }, configurable: true });
  Object.defineProperty(globalThis, "getComputedStyle", {
    value: () => ({ getPropertyValue: () => "#0078d7" }),
    configurable: true
  });
  Object.defineProperty(globalThis, "history", {
    value: {
      replaceState(_state, _title, url) {
        const hashAt = String(url).indexOf("#");
        location.hash = hashAt === -1 ? "" : String(url).slice(hashAt);
      }
    },
    configurable: true
  });
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, "crypto", {
    value: {
      getRandomValues(bytes) {
        for (let idx = 0; idx < bytes.length; idx += 1) {
          bytes[idx] = (idx + 11 + randomOffset) % 256;
        }
        randomOffset += 17;
        return bytes;
      }
    },
    configurable: true
  });
}

function nextMessage(transport, event) {
  return new Promise((resolve) => {
    transport.on(event, resolve);
  });
}

async function connect(transport) {
  const snapshot = nextMessage(transport, "snapshot");
  transport.connect();
  return snapshot;
}

const beginner = { seed: "solo-seed", w: 9, h: 9, mineCount: 10 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  installBrowserGlobals();
});

describe("createLocalTransport solo persistence", () => {
  it("restores a mid-game board with revealed cells and the original timer start", async () => {
    const first = createLocalTransport(beginner, { name: "Solo" });
    await connect(first);

    const firstEvents = nextMessage(first, "events");
    first.send({ type: "REVEAL", idx: 40, seq: 1 });
    const started = await firstEvents;
    const opened = started.events.find((event) => event.t === "OPEN").cells.length;

    vi.setSystemTime(5000);
    const reloaded = createLocalTransport(beginner, { name: "Solo" });
    const snapshot = await connect(reloaded);

    expect(snapshot.config.seed).toBe("solo-seed");
    expect(snapshot.status).toBe(Status.PLAYING);
    expect(snapshot.startedAt).toBe(1000);
    expect(snapshot.revealed).toHaveLength(opened);
    expect(snapshot.leaderboardIneligibleReason).toBe("");
  });

  it("marks a previously started board ineligible when progress storage is missing", async () => {
    const first = createLocalTransport(beginner, { name: "Solo" });
    await connect(first);

    const firstEvents = nextMessage(first, "events");
    first.send({ type: "REVEAL", idx: 40, seq: 1 });
    await firstEvents;
    sessionStorage.clear();

    const replayed = createLocalTransport(beginner, { name: "Solo" });
    const snapshot = await connect(replayed);

    expect(snapshot.status).toBe(Status.PENDING);
    expect(snapshot.revealed).toHaveLength(0);
    expect(snapshot.leaderboardIneligibleReason).toBe("replayed_board");

    const replayEvents = nextMessage(replayed, "events");
    replayed.send({ type: "REVEAL", idx: 40, seq: 2 });
    expect((await replayEvents).leaderboardIneligibleReason).toBe("replayed_board");
  });

  it("uses fresh eligible seeds for face reset and settings new game", async () => {
    const transport = createLocalTransport(beginner, { name: "Solo" });
    const initial = await connect(transport);

    const firstEvents = nextMessage(transport, "events");
    transport.send({ type: "REVEAL", idx: 40, seq: 1 });
    await firstEvents;

    const resetSnapshot = nextMessage(transport, "snapshot");
    transport.reset();
    const reset = await resetSnapshot;

    expect(reset.config.seed).not.toBe(initial.config.seed);
    expect(reset.status).toBe(Status.PENDING);
    expect(reset.leaderboardIneligibleReason).toBe("");

    const reconfigSnapshot = nextMessage(transport, "snapshot");
    transport.reconfig({ w: 16, h: 16, mineCount: 40 });
    const reconfigured = await reconfigSnapshot;

    expect(reconfigured.config.seed).not.toBe(reset.config.seed);
    expect(reconfigured.config).toMatchObject({ w: 16, h: 16, mineCount: 40 });
    expect(reconfigured.leaderboardIneligibleReason).toBe("");
  });
});
