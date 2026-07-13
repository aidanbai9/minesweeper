import { DurableObject } from "cloudflare:workers";
import { PRESETS } from "../../engine/src/index.js";
import { cleanName } from "./protocol.js";

const MAX_ENTRIES = 50;
const PRESET_KEYS = Object.freeze(Object.keys(PRESETS));

function boardKey(preset) {
  return `lb:${preset}`;
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

  const players = Array.isArray(entry.players)
    ? entry.players.map((name) => cleanName(name)).filter((name) => name.length > 0)
    : [];

  return { timeMs, players, preset, finishedAt };
}

function sortEntries(a, b) {
  return a.timeMs - b.timeMs || a.finishedAt - b.finishedAt;
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
      boards[preset] = entries.slice(0, MAX_ENTRIES);
    }
    return boards;
  }
}
