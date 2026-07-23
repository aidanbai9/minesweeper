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

function contributor(name, token = `tok-${name}`) {
  return { name, token };
}

async function storedEntries(preset, mode = "standard") {
  const stub = leaderboard();
  return (await runInDurableObject(stub, async (_instance, state) => state.storage.get(`lb:${preset}:${mode}`))) || [];
}

async function storedValue(key) {
  const stub = leaderboard();
  return runInDurableObject(stub, async (_instance, state) => state.storage.get(key));
}

async function putStoredValue(key, value) {
  const stub = leaderboard();
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(key, value);
  });
}

async function submitWin(overrides = {}) {
  return SELF.fetch(
    new Request("https://mines.test/leaderboard/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": overrides.ip || "203.0.113.10"
      },
      body: JSON.stringify({
        preset: "ignored-client-label",
        mode: "standard",
        timeMs: 1234,
        name: "Ada",
        token: "tok-submit",
        assistUsed: false,
        w: 9,
        h: 9,
        mineCount: 10,
        ...overrides
      })
    })
  );
}

describe("Leaderboard", () => {
  it("migrates legacy standard entries into modern storage with de-dupe, caps, truncation, and legacy delete", async () => {
    const lb = leaderboard();
    await putStoredValue("lb:beginner:standard", [entry({ timeMs: 400, finishedAt: 1, contributors: [contributor("Zoe")] })]);
    await putStoredValue("lb:beginner", [
      entry({ timeMs: 500, finishedAt: 2, contributors: [contributor("Ada", "tok-a-500")] }),
      entry({ timeMs: 500, finishedAt: 2, contributors: [contributor("Ada", "tok-a-500")] }),
      ...Array.from({ length: 7 }, (_, i) =>
        entry({ timeMs: 501 + i, finishedAt: 10 + i, contributors: [contributor("Ada", `tok-a-${501 + i}`)] })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        entry({ timeMs: 1000 + i, finishedAt: 1000 + i, contributors: [contributor(`Player ${i}`)] })
      )
    ]);

    await lb.getBoards();
    const stored = await storedEntries("beginner");

    expect(await storedValue("lb:beginner")).toBeUndefined();
    expect(await storedValue("migratedV2")).toBe(true);
    expect(stored).toHaveLength(50);
    expect(stored.filter((item) => item.contributors.some((itemContributor) => itemContributor.name === "Ada"))).toHaveLength(6);
    expect(stored.map((item) => item.timeMs)).toEqual([400, 500, 501, 502, 503, 504, 505, ...Array.from({ length: 43 }, (_, i) => 1000 + i)]);
  });

  it("runs the legacy migration only once", async () => {
    const lb = leaderboard();
    await putStoredValue("lb:beginner", [entry({ timeMs: 900, finishedAt: 1, contributors: [contributor("Ada")] })]);

    await lb.getBoards();
    await putStoredValue("lb:beginner", [entry({ timeMs: 800, finishedAt: 2, contributors: [contributor("Bob")] })]);
    await lb.getBoards();

    expect((await storedEntries("beginner")).map((item) => item.timeMs)).toEqual([900]);
    expect(await storedValue("lb:beginner")).toHaveLength(1);
  });

  it("recordWin persists the full migrated list instead of stranding legacy entries", async () => {
    const lb = leaderboard();
    await putStoredValue("lb:beginner", [entry({ timeMs: 700, finishedAt: 1, contributors: [contributor("Legacy")] })]);
    await putStoredValue("lb:beginner:standard", [entry({ timeMs: 800, finishedAt: 2, contributors: [contributor("Modern")] })]);

    await lb.recordWin(entry({ timeMs: 600, finishedAt: 3, contributors: [contributor("New")] }));

    expect((await storedEntries("beginner")).map((item) => item.timeMs)).toEqual([600, 700, 800]);
    expect(await storedValue("lb:beginner")).toBeUndefined();
  });

  it("keeps exactly the 50 fastest entries when inserting 60", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 60; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, finishedAt: 100000 + i, contributors: [contributor(`Player ${i}`)] }));
    }

    const boards = await lb.getBoards();
    expect(boards.beginner.standard).toHaveLength(50);
    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual(Array.from({ length: 50 }, (_, i) => 1000 + i));
  });

  it("sorts by time and breaks ties by earlier finish time", async () => {
    const lb = leaderboard();
    await lb.recordWin(entry({ timeMs: 900, finishedAt: 300000 }));
    await lb.recordWin(entry({ timeMs: 800, finishedAt: 300000 }));
    await lb.recordWin(entry({ timeMs: 900, finishedAt: 200000 }));

    const boards = await lb.getBoards();
    expect(boards.beginner.standard.map((item) => [item.timeMs, item.finishedAt])).toEqual([
      [800, 300000],
      [900, 200000],
      [900, 300000]
    ]);
  });

  it("reports outside_top_50 for a slow entry that does not make the top 50", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 50; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, finishedAt: 100000 + i, contributors: [contributor(`Player ${i}`)] }));
    }

    const result = await lb.recordWin(entry({ timeMs: 9999, finishedAt: 999999, contributors: [contributor("Slowpoke")] }));
    const boards = await lb.getBoards();

    expect(result).toEqual({ ranked: false, reason: "outside_top_50" });
    expect(boards.beginner.standard).toHaveLength(50);
    expect(boards.beginner.standard.some((item) => item.timeMs === 9999)).toBe(false);
  });

  it("keeps each preset board independent", async () => {
    const lb = leaderboard();
    await lb.recordWin(entry({ preset: "beginner", timeMs: 1000 }));
    await lb.recordWin(entry({ preset: "expert", timeMs: 2000 }));

    const boards = await lb.getBoards();
    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual([1000]);
    expect(boards.expert.standard.map((item) => item.timeMs)).toEqual([2000]);
    expect(boards.intermediate.standard).toEqual([]);
    expect(boards.zhenghua.standard).toEqual([]);
  });

  it("serves contributor names without exposing session tokens", async () => {
    const lb = leaderboard();
    await lb.recordWin(entry({ contributors: [{ name: "Ada", token: "private-token" }] }));

    const boards = await lb.getBoards();

    expect(boards.beginner.standard[0].contributors).toEqual([{ name: "Ada" }]);
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

  it("keeps standard and no-guess boards independent", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 60; i += 1) {
      await lb.recordWin(
        entry({ mode: "noguess", timeMs: 1000 + i, finishedAt: 100000 + i, contributors: [contributor(`No Guess ${i}`)] })
      );
    }
    await lb.recordWin(entry({ mode: "standard", timeMs: 5000, finishedAt: 200000 }));

    const boards = await lb.getBoards();
    expect(boards.beginner.noguess).toHaveLength(50);
    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual([5000]);
    expect(await storedEntries("beginner", "noguess")).toHaveLength(50);
    expect(await storedEntries("beginner", "standard")).toHaveLength(1);
  });

  it("reports outside_personal_best for a globally rankable 7th slower contributor time", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 6; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, contributors: [contributor("Ada", `tok-a-${i}`)] }));
    }

    const result = await lb.recordWin(entry({ timeMs: 2000, contributors: [contributor("Ada", "tok-a-slow")] }));
    const boards = await lb.getBoards();

    expect(result).toEqual({ ranked: false, reason: "outside_personal_best", cap: 6 });
    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual([1000, 1001, 1002, 1003, 1004, 1005]);
  });

  it("ranks a contributor's 7th faster time and evicts their slowest prior entry", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 6; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, contributors: [contributor("Ada", `tok-a-${i}`)] }));
    }

    const result = await lb.recordWin(entry({ timeMs: 900, contributors: [contributor("Ada", "tok-a-fast")] }));
    const boards = await lb.getBoards();

    expect(result).toEqual({ ranked: true, rank: 1 });
    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual([900, 1000, 1001, 1002, 1003, 1004]);
  });

  it("keeps only a contributor's 6 fastest Beginner wins after 8 runs", async () => {
    const lb = leaderboard();
    for (const timeMs of [1000, 1100, 900, 1200, 800, 1300, 700, 1400]) {
      await lb.recordWin(entry({ timeMs, contributors: [contributor("aidan", `tok-aidan-${timeMs}`)] }));
    }

    const boards = await lb.getBoards();

    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual([700, 800, 900, 1000, 1100, 1200]);
    expect(boards.beginner.standard.every((item) => item.contributors[0].name === "aidan")).toBe(true);
  });

  it("caps different contributor names independently on the same board", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 6; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, contributors: [contributor("Ada", `tok-a-${i}`)] }));
      await lb.recordWin(entry({ timeMs: 2000 + i, contributors: [contributor("Bob", `tok-b-${i}`)] }));
    }

    await lb.recordWin(entry({ timeMs: 1500, contributors: [contributor("Bob", "tok-b-fast")] }));
    const boards = await lb.getBoards();
    const entries = boards.beginner.standard;

    expect(entries.filter((item) => item.contributors.some((itemContributor) => itemContributor.name === "Ada"))).toHaveLength(6);
    expect(entries.filter((item) => item.contributors.some((itemContributor) => itemContributor.name === "Bob"))).toHaveLength(6);
    expect(entries.map((item) => item.timeMs)).not.toContain(2005);
  });

  it("ranks a group entry when one capped contributor is blocked but another contributor has room", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 6; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, contributors: [contributor("Ada", `tok-a-${i}`)] }));
    }

    const result = await lb.recordWin(entry({ timeMs: 2000, contributors: [contributor("Ada", "tok-a-group"), contributor("Bob")] }));
    const boards = await lb.getBoards();

    expect(result).toEqual({ ranked: true, rank: 7 });
    expect(boards.beginner.standard).toHaveLength(7);
    expect(boards.beginner.standard.at(-1).contributors).toEqual([{ name: "Bob" }]);
    expect(boards.beginner.standard.filter((item) => item.contributors.some((itemContributor) => itemContributor.name === "Ada"))).toHaveLength(6);
  });

  it("accepts a group entry when one contributor has room and the other evicts a slower entry", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 6; i += 1) {
      await lb.recordWin(entry({ timeMs: 3000 + i, contributors: [contributor("Bob", `tok-b-${i}`)] }));
    }

    await lb.recordWin(entry({ timeMs: 2000, contributors: [contributor("Ada"), contributor("Bob", "tok-b-group")] }));
    const boards = await lb.getBoards();
    const entries = boards.beginner.standard;

    expect(entries.map((item) => item.timeMs)).toEqual([2000, 3000, 3001, 3002, 3003, 3004]);
    expect(entries.filter((item) => item.contributors.some((itemContributor) => itemContributor.name === "Ada"))).toHaveLength(1);
    expect(entries.filter((item) => item.contributors.some((itemContributor) => itemContributor.name === "Bob"))).toHaveLength(6);
  });

  it("allows rename to temporarily exceed the cap and trims on the next insert for that name", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 6; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, contributors: [contributor("Bob", `tok-b-${i}`)] }));
      await lb.recordWin(entry({ timeMs: 2000 + i, contributors: [contributor("Ada", "tok-a")] }));
    }

    const renamed = await lb.renameToken("tok-a", "Bob");
    const afterRename = await storedEntries("beginner");

    expect(renamed).toBe(6);
    expect(afterRename).toHaveLength(12);
    expect(afterRename.filter((item) => item.contributors.some((itemContributor) => itemContributor.name === "Bob"))).toHaveLength(12);

    await lb.recordWin(entry({ timeMs: 500, contributors: [contributor("Bob", "tok-b-best")] }));
    const boards = await lb.getBoards();

    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual([500, 1000, 1001, 1002, 1003, 1004]);
    expect(boards.beginner.standard).toHaveLength(6);
  });

  it("still applies global top-50 truncation after per-name logic", async () => {
    const lb = leaderboard();
    for (let i = 0; i < 50; i += 1) {
      await lb.recordWin(entry({ timeMs: 1000 + i, finishedAt: 100000 + i, contributors: [contributor(`Player ${i}`)] }));
    }

    await lb.recordWin(entry({ timeMs: 900, finishedAt: 200000, contributors: [contributor("Ada")] }));
    const boards = await lb.getBoards();

    expect(boards.beginner.standard).toHaveLength(50);
    expect(boards.beginner.standard.map((item) => item.timeMs)).toEqual([900, ...Array.from({ length: 49 }, (_, i) => 1000 + i)]);
  });

  it("serves GET /leaderboard as JSON with CORS and cache headers", async () => {
    const response = await SELF.fetch("https://mines.test/leaderboard");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body).toEqual({
      beginner: { standard: [], noguess: [] },
      intermediate: { standard: [], noguess: [] },
      expert: { standard: [], noguess: [] },
      zhenghua: { standard: [], noguess: [] }
    });
  });

  it("keeps GET /leaderboard-debug disabled unless the temporary flag is enabled", async () => {
    const response = await SELF.fetch("https://mines.test/leaderboard-debug");

    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("POST /leaderboard/submit records a valid preset win and returns the rank", async () => {
    const response = await submitWin({ preset: "expert", token: "tok-http-valid" });
    const body = await response.json();
    const entries = await storedEntries("beginner");

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(body).toEqual({ ranked: true, rank: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      preset: "beginner",
      mode: "standard",
      timeMs: 1234,
      contributors: [{ name: "Ada", token: "tok-http-valid" }]
    });
  });

  it("POST /leaderboard/submit rejects non-preset dimensions without recording", async () => {
    const response = await submitWin({ token: "tok-http-custom", w: 10, h: 10, mineCount: 10 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_preset", reason: "custom" });
    expect(await storedEntries("beginner")).toEqual([]);
  });

  it("POST /leaderboard/submit rejects no-guess submissions for non-expert presets", async () => {
    const response = await submitWin({ token: "tok-http-bad-ng", mode: "noguess" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_mode" });
    expect(await storedEntries("beginner")).toEqual([]);
  });

  it("POST /leaderboard/submit rejects assisted games without recording", async () => {
    const response = await submitWin({ token: "tok-http-assist", assistUsed: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "assist_used", reason: "assist" });
    expect(await storedEntries("beginner")).toEqual([]);
  });

  it("POST /leaderboard/submit rejects absurd times without recording", async () => {
    const responses = [];
    responses.push(await submitWin({ token: "tok-http-time-0", timeMs: 0 }));
    responses.push(await submitWin({ token: "tok-http-time-neg", timeMs: -1 }));
    responses.push(await submitWin({ token: "tok-http-time-long", timeMs: 24 * 60 * 60 * 1000 + 1 }));

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({ error: "bad_time" });
    }
    expect(await storedEntries("beginner")).toEqual([]);
  });

  it("POST /leaderboard/submit rejects invalid names without recording", async () => {
    const response = await submitWin({ token: "tok-http-bad-name", name: "\u0000\u0007   " });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_name" });
    expect(await storedEntries("beginner")).toEqual([]);
  });

  it("POST /leaderboard/submit rate-limits rapid repeated submissions", async () => {
    const responses = [];
    for (let i = 0; i < 10; i += 1) {
      responses.push(await submitWin({ token: "tok-http-rate", timeMs: 1000 + i, ip: "203.0.113.20" }));
    }

    expect(responses.filter((response) => response.status === 200)).toHaveLength(6);
    expect(responses.filter((response) => response.status === 429).length).toBeGreaterThan(0);
    expect(await storedEntries("beginner")).toHaveLength(6);
  });

  it("OPTIONS /leaderboard/submit returns CORS preflight headers", async () => {
    const response = await SELF.fetch(
      new Request("https://mines.test/leaderboard/submit", {
        method: "OPTIONS",
        headers: {
          Origin: "https://aidanbai.github.io",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type"
        }
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("POST /leaderboard/submit applies the per-username cap like online wins", async () => {
    for (const timeMs of [1000, 1100, 900, 1200, 800, 1300, 700, 1400]) {
      await submitWin({ name: "Solo Cap", token: `tok-http-cap-${timeMs}`, timeMs });
    }

    const entries = await storedEntries("beginner");

    expect(entries.map((item) => item.timeMs)).toEqual([700, 800, 900, 1000, 1100, 1200]);
    expect(entries.every((item) => item.contributors[0].name === "Solo Cap")).toBe(true);
  });
});
