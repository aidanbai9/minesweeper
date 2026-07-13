import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";

function entry(overrides = {}) {
  return {
    timeMs: 1000,
    contributors: [{ name: "Ada", token: "tok-a" }],
    preset: "beginner",
    finishedAt: 100000,
    ...overrides
  };
}

function leaderboard() {
  return env.LEADERBOARD.getByName("global");
}

async function storedEntries(preset) {
  const stub = leaderboard();
  return (await runInDurableObject(stub, async (_instance, state) => state.storage.get(`lb:${preset}`))) || [];
}

describe("Leaderboard", () => {
  it("keeps exactly the 50 fastest entries when inserting 60", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 60; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, finishedAt: 100000 + i }));
    }

    const boards = await lb.getBoards();
    expect(boards.beginner).toHaveLength(50);
    expect(boards.beginner.map((item) => item.timeMs)).toEqual(Array.from({ length: 50 }, (_, i) => 1000 + i));
  });

  it("sorts by time and breaks ties by earlier finish time", async () => {
    const lb = leaderboard();
    await lb.recordWin(entry({ timeMs: 900, finishedAt: 300000 }));
    await lb.recordWin(entry({ timeMs: 800, finishedAt: 300000 }));
    await lb.recordWin(entry({ timeMs: 900, finishedAt: 200000 }));

    const boards = await lb.getBoards();
    expect(boards.beginner.map((item) => [item.timeMs, item.finishedAt])).toEqual([
      [800, 300000],
      [900, 200000],
      [900, 300000]
    ]);
  });

  it("drops a slow entry that does not make the top 50", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 50; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, finishedAt: 100000 + i }));
    }

    const rank = await lb.recordWin(entry({ timeMs: 9999, finishedAt: 999999 }));
    const boards = await lb.getBoards();

    expect(rank).toBeNull();
    expect(boards.beginner).toHaveLength(50);
    expect(boards.beginner.some((item) => item.timeMs === 9999)).toBe(false);
  });

  it("keeps each preset board independent", async () => {
    const lb = leaderboard();
    await lb.recordWin(entry({ preset: "beginner", timeMs: 1000 }));
    await lb.recordWin(entry({ preset: "expert", timeMs: 2000 }));

    const boards = await lb.getBoards();
    expect(boards.beginner.map((item) => item.timeMs)).toEqual([1000]);
    expect(boards.expert.map((item) => item.timeMs)).toEqual([2000]);
    expect(boards.intermediate).toEqual([]);
    expect(boards.zhenghua).toEqual([]);
  });

  it("serves contributor names without exposing session tokens", async () => {
    const lb = leaderboard();
    await lb.recordWin(entry({ contributors: [{ name: "Ada", token: "private-token" }] }));

    const boards = await lb.getBoards();

    expect(boards.beginner[0].contributors).toEqual([{ name: "Ada" }]);
    expect(JSON.stringify(boards)).not.toContain("private-token");
  });

  it("renames only matching contributor tokens without changing timing or order", async () => {
    const lb = leaderboard();
    await lb.recordWin(entry({ timeMs: 900, finishedAt: 300000, contributors: [{ name: "aidan", token: "tok-a" }] }));
    await lb.recordWin(entry({ timeMs: 800, finishedAt: 200000, contributors: [{ name: "aidan", token: "tok-b" }] }));
    await lb.recordWin(entry({ timeMs: 950, finishedAt: 100000, contributors: [{ name: "Ada", token: "tok-a" }] }));
    const before = await storedEntries("beginner");
    const beforeTiming = before.map((item) => [item.timeMs, item.finishedAt]);
    const beforeTokens = before.map((item) => item.contributors.map((contributor) => contributor.token));

    const renamed = await lb.renameToken("tok-a", "Ada Prime");
    const after = await storedEntries("beginner");

    expect(renamed).toBe(2);
    expect(after.map((item) => [item.timeMs, item.finishedAt])).toEqual(beforeTiming);
    expect(after.map((item) => item.contributors.map((contributor) => contributor.token))).toEqual(beforeTokens);
    expect(after.map((item) => item.contributors[0].name)).toEqual(["aidan", "Ada Prime", "Ada Prime"]);
  });

  it("serves GET /leaderboard as JSON with CORS and cache headers", async () => {
    const response = await SELF.fetch("https://mines.test/leaderboard");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body).toEqual({
      beginner: [],
      intermediate: [],
      expert: [],
      zhenghua: []
    });
  });
});
