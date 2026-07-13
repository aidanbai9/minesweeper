import { DurableObject } from "cloudflare:workers";
import { PRESETS } from "../../engine/src/index.js";
import { cleanName, cleanToken } from "./protocol.js";

const MAX_ENTRIES = 50;
const PRESET_KEYS = Object.freeze(Object.keys(PRESETS));

function boardKey(preset) {
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

  return { timeMs, contributors, preset, finishedAt };
}

function sortEntries(a, b) {
  return a.timeMs - b.timeMs || a.finishedAt - b.finishedAt;
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
    const key = boardKey(normalized.preset);
    const entries = ((await this.ctx.storage.get(key)) || []).map(normalizeEntry);
    entries.push(normalized);
    entries.sort(sortEntries);
    const kept = entries.slice(0, MAX_ENTRIES);
    await this.ctx.storage.put(key, kept);

    const rank = kept.indexOf(normalized);
    return rank === -1 ? null : rank + 1;
  }

  async getBoards() {
    const boards = {};
    for (const preset of PRESET_KEYS) {
      const entries = ((await this.ctx.storage.get(boardKey(preset))) || []).map(normalizeEntry);
      entries.sort(sortEntries);
      boards[preset] = entries.slice(0, MAX_ENTRIES).map(publicEntry);
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
      const key = boardKey(preset);
      const entries = ((await this.ctx.storage.get(key)) || []).map(normalizeEntry);
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
        await this.ctx.storage.put(key, entries.slice(0, MAX_ENTRIES));
      }
    }
    return renamed;
  }
}
