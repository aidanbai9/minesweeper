import { DurableObject } from "cloudflare:workers";
import { PRESETS } from "../../engine/src/index.js";
import { cleanName, cleanToken } from "./protocol.js";

const MAX_ENTRIES = 50;
const MAX_ENTRIES_PER_CONTRIBUTOR = 6;
const PRESET_KEYS = Object.freeze(Object.keys(PRESETS));
const MODES = Object.freeze(["standard", "noguess"]);

function normalizeMode(mode) {
  return mode === "noguess" ? "noguess" : "standard";
}

function boardKey(preset, mode = "standard") {
  return `lb:${preset}:${normalizeMode(mode)}`;
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
  async recordWin(entry) {
    const normalized = normalizeEntry(entry);
    const key = boardKey(normalized.preset, normalized.mode);
    const entries = ((await this.ctx.storage.get(key)) || []).map(normalizeEntry);
    const topCandidates = [...entries, normalized].sort(sortEntries);
    if (!topCandidates.slice(0, MAX_ENTRIES).includes(normalized)) {
      return null;
    }

    const capped = applyContributorCap(entries, normalized);
    if (!capped) {
      return null;
    }

    const kept = [...capped, normalized].sort(sortEntries).slice(0, MAX_ENTRIES);
    await this.ctx.storage.put(key, kept);

    const rank = kept.indexOf(normalized);
    return rank === -1 ? null : rank + 1;
  }

  async getBoards() {
    const boards = {};
    for (const preset of PRESET_KEYS) {
      boards[preset] = {};
      for (const mode of MODES) {
        const modern = await this.ctx.storage.get(boardKey(preset, mode));
        const legacy = mode === "standard" ? await this.ctx.storage.get(`lb:${preset}`) : null;
        const entries = (modern || legacy || []).map((entry) => normalizeEntry({ ...entry, mode }));
        entries.sort(sortEntries);
        boards[preset][mode] = entries.slice(0, MAX_ENTRIES).map(publicEntry);
      }
    }
    return boards;
  }

  async renameToken(token, name) {
    const cleanedToken = cleanToken(token);
    const cleanedName = cleanName(name);
    if (!cleanedToken || !cleanedName) {
      return 0;
    }

    let renamed = 0;
    for (const preset of PRESET_KEYS) {
      for (const mode of MODES) {
        const key = boardKey(preset, mode);
        const entries = ((await this.ctx.storage.get(key)) || []).map((entry) => normalizeEntry({ ...entry, mode }));
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
          await this.ctx.storage.put(key, entries.slice(0, MAX_ENTRIES));
        }
      }
    }
    return renamed;
  }
}
