import { DurableObject } from "cloudflare:workers";
import { PRESETS } from "../../engine/src/index.js";
import { cleanName, cleanToken } from "./protocol.js";

const MAX_ENTRIES = 50;
const MAX_ENTRIES_PER_CONTRIBUTOR = 6;
const PRESET_KEYS = Object.freeze(Object.keys(PRESETS));
const MODES = Object.freeze(["standard", "noguess"]);
const MIGRATED_V2_KEY = "migratedV2";

function normalizeMode(mode) {
  return mode === "noguess" ? "noguess" : "standard";
}

function boardKey(preset, mode = "standard") {
  return `lb:${preset}:${normalizeMode(mode)}`;
}

function legacyBoardKey(preset) {
  return `lb:${preset}`;
}

function normalizeContributor(contributor) {
  if (!contributor || typeof contributor !== "object" || Array.isArray(contributor)) {
    return null;
  }
  const name = cleanName(contributor.name);
  if (!name) {
    return null;
  }
  return { name, token: cleanToken(contributor.token) };
}

function normalizeLegacyPlayer(name) {
  const cleaned = cleanName(name);
  return cleaned ? { name: cleaned, token: "" } : null;
}

function normalizeEntry(entry) {
  const preset = typeof entry?.preset === "string" && PRESET_KEYS.includes(entry.preset) ? entry.preset : "";
  if (!preset) {
    throw new Error("Invalid leaderboard preset");
  }

  const timeMs = Math.trunc(Number(entry.timeMs));
  const finishedAt = Math.trunc(Number(entry.finishedAt));
  if (!Number.isFinite(timeMs) || timeMs < 0 || !Number.isFinite(finishedAt) || finishedAt < 0) {
    throw new Error("Invalid leaderboard timing");
  }

  const contributors = Array.isArray(entry.contributors)
    ? entry.contributors.map(normalizeContributor).filter(Boolean)
    : Array.isArray(entry.players)
      ? entry.players.map(normalizeLegacyPlayer).filter(Boolean)
      : [];

  return { timeMs, contributors, preset, mode: normalizeMode(entry.mode), finishedAt };
}

function sortEntries(a, b) {
  return a.timeMs - b.timeMs || a.finishedAt - b.finishedAt;
}

function sortEntriesSlowestFirst(a, b) {
  return b.timeMs - a.timeMs || b.finishedAt - a.finishedAt;
}

function contributorNames(entry) {
  return new Set(entry.contributors.map((contributor) => contributor.name));
}

function hasContributor(entry, name) {
  return entry.contributors.some((contributor) => contributor.name === name);
}

function isFasterThan(entry, existing) {
  return entry.timeMs < existing.timeMs;
}

function entryIdentity(entry) {
  const contributors = entry.contributors
    .map((contributor) => `${contributor.name}\u0000${contributor.token}`)
    .sort()
    .join("\u0001");
  return `${entry.timeMs}\u0002${entry.finishedAt}\u0002${contributors}`;
}

function dedupeEntries(entries) {
  const seen = new Set();
  const kept = [];
  for (const entry of entries) {
    const identity = entryIdentity(entry);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    kept.push(entry);
  }
  return kept;
}

function trimBoardEntries(entries) {
  const contributorCounts = new Map();
  const kept = [];
  for (const entry of dedupeEntries(entries).sort(sortEntries)) {
    const names = contributorNames(entry);
    if ([...names].some((name) => (contributorCounts.get(name) || 0) >= MAX_ENTRIES_PER_CONTRIBUTOR)) {
      continue;
    }
    kept.push(entry);
    for (const name of names) {
      contributorCounts.set(name, (contributorCounts.get(name) || 0) + 1);
    }
    if (kept.length >= MAX_ENTRIES) {
      break;
    }
  }
  return kept;
}

function applyContributorCap(entries, entry) {
  let kept = [...entries];
  for (const name of contributorNames(entry)) {
    const existing = kept.filter((item) => hasContributor(item, name));
    const evictCount = existing.length + 1 - MAX_ENTRIES_PER_CONTRIBUTOR;
    if (evictCount <= 0) {
      continue;
    }

    const evicted = existing.sort(sortEntriesSlowestFirst).slice(0, evictCount);
    if (evicted.some((item) => !isFasterThan(entry, item))) {
      return null;
    }

    const evictedSet = new Set(evicted);
    kept = kept.filter((item) => !evictedSet.has(item));
  }

  for (const name of contributorNames(entry)) {
    if (kept.filter((item) => hasContributor(item, name)).length + 1 > MAX_ENTRIES_PER_CONTRIBUTOR) {
      return null;
    }
  }

  return kept;
}

function publicEntry(entry) {
  return {
    timeMs: entry.timeMs,
    contributors: entry.contributors.map((contributor) => ({ name: contributor.name })),
    preset: entry.preset,
    finishedAt: entry.finishedAt
  };
}

export class Leaderboard extends DurableObject {
  async readBoardEntries(preset, mode) {
    const normalizedMode = normalizeMode(mode);
    return ((await this.ctx.storage.get(boardKey(preset, normalizedMode))) || []).map((entry) =>
      normalizeEntry({ ...entry, preset, mode: normalizedMode })
    );
  }

  async writeBoardEntries(preset, mode, entries, options = {}) {
    const normalizedMode = normalizeMode(mode);
    const normalizedEntries = entries.map((entry) => normalizeEntry({ ...entry, preset, mode: normalizedMode }));
    const storedEntries = options.trim === false ? normalizedEntries.sort(sortEntries).slice(0, MAX_ENTRIES) : trimBoardEntries(normalizedEntries);
    await this.ctx.storage.put(boardKey(preset, normalizedMode), storedEntries);
  }

  async migrateV2() {
    if (await this.ctx.storage.get(MIGRATED_V2_KEY)) {
      return false;
    }

    for (const preset of PRESET_KEYS) {
      const legacyKey = legacyBoardKey(preset);
      const legacyEntries = ((await this.ctx.storage.get(legacyKey)) || []).map((entry) =>
        normalizeEntry({ ...entry, preset, mode: "standard" })
      );
      if (legacyEntries.length > 0) {
        const modernEntries = await this.readBoardEntries(preset, "standard");
        await this.writeBoardEntries(preset, "standard", [...modernEntries, ...legacyEntries]);
      }
      await this.ctx.storage.delete(legacyKey);
    }

    await this.ctx.storage.put(MIGRATED_V2_KEY, true);
    return true;
  }

  async debugSnapshot() {
    const keys = {};
    for (const [key, value] of await this.ctx.storage.list()) {
      keys[key] = { count: Array.isArray(value) ? value.length : null };
    }

    const presets = {};
    for (const preset of PRESET_KEYS) {
      const legacy = await this.ctx.storage.get(legacyBoardKey(preset));
      const standard = await this.ctx.storage.get(boardKey(preset, "standard"));
      const noguess = await this.ctx.storage.get(boardKey(preset, "noguess"));
      presets[preset] = {
        legacy: { key: legacyBoardKey(preset), count: Array.isArray(legacy) ? legacy.length : 0, exists: Array.isArray(legacy) },
        standard: {
          key: boardKey(preset, "standard"),
          count: Array.isArray(standard) ? standard.length : 0,
          exists: Array.isArray(standard)
        },
        noguess: {
          key: boardKey(preset, "noguess"),
          count: Array.isArray(noguess) ? noguess.length : 0,
          exists: Array.isArray(noguess)
        }
      };
    }

    return {
      temporary: true,
      readOnly: true,
      migratedV2: (await this.ctx.storage.get(MIGRATED_V2_KEY)) === true,
      keys,
      presets
    };
  }

  async recordWin(entry) {
    await this.migrateV2();
    const normalized = normalizeEntry(entry);
    const entries = await this.readBoardEntries(normalized.preset, normalized.mode);
    const topCandidates = [...entries, normalized].sort(sortEntries);
    if (!topCandidates.slice(0, MAX_ENTRIES).includes(normalized)) {
      return null;
    }

    const capped = applyContributorCap(entries, normalized);
    if (!capped) {
      return null;
    }

    const kept = trimBoardEntries([...capped, normalized]);
    await this.writeBoardEntries(normalized.preset, normalized.mode, kept);

    const rank = kept.indexOf(normalized);
    return rank === -1 ? null : rank + 1;
  }

  async getBoards() {
    await this.migrateV2();
    const boards = {};
    for (const preset of PRESET_KEYS) {
      boards[preset] = {};
      for (const mode of MODES) {
        const entries = await this.readBoardEntries(preset, mode);
        entries.sort(sortEntries);
        boards[preset][mode] = entries.slice(0, MAX_ENTRIES).map(publicEntry);
      }
    }
    return boards;
  }

  async renameToken(token, name) {
    await this.migrateV2();
    const cleanedToken = cleanToken(token);
    const cleanedName = cleanName(name);
    if (!cleanedToken || !cleanedName) {
      return 0;
    }

    let renamed = 0;
    for (const preset of PRESET_KEYS) {
      for (const mode of MODES) {
        const entries = await this.readBoardEntries(preset, mode);
        let changed = false;
        for (const entry of entries) {
          for (const contributor of entry.contributors) {
            if (contributor.token === cleanedToken) {
              contributor.name = cleanedName;
              renamed += 1;
              changed = true;
            }
          }
        }
        if (changed) {
          // A rename can merge two already-full names and temporarily put one name
          // over the per-board cap. Do not delete entries here; the cap is enforced
          // only when future wins are inserted so renames never silently destroy runs.
          await this.writeBoardEntries(preset, mode, entries, { trim: false });
        }
      }
    }
    return renamed;
  }
}
