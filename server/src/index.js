import { GameRoom } from "./GameRoom.js";
import { Leaderboard } from "./Leaderboard.js";
import { NOGUESS_PRESETS, presetKeyForConfig } from "../../engine/src/index.js";
import { isValidRoomCode } from "./ids.js";
import { cleanName, cleanToken } from "./protocol.js";

export { GameRoom, Leaderboard };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const SUBMIT_RATE_WINDOW_MS = 60 * 1000;
const SUBMIT_RATE_LIMIT = 6;
const MAX_SUBMITTED_TIME_MS = 24 * 60 * 60 * 1000;
const submitRates = new Map();

function text(body, status = 200) {
  return new Response(body, { status, headers: CORS });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}

function clientIp(request) {
  const forwarded = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
  return forwarded.split(",")[0].trim() || "unknown";
}

function rateLimitKey(request, token) {
  const cleanedToken = cleanToken(token);
  return cleanedToken ? `token:${cleanedToken}` : `ip:${clientIp(request)}`;
}

function submitRateAllowed(key, now) {
  const current = submitRates.get(key);
  const rate = current && now - current.windowStart < SUBMIT_RATE_WINDOW_MS ? current : { windowStart: now, count: 0 };
  if (rate.count >= SUBMIT_RATE_LIMIT) {
    submitRates.set(key, rate);
    return false;
  }
  rate.count += 1;
  submitRates.set(key, rate);
  return true;
}

function validateSubmitPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "bad_request", message: "Body must be a JSON object" };
  }
  if (typeof value.name !== "string") {
    return { ok: false, status: 400, error: "bad_name", reason: "name", message: "Name must be a string" };
  }
  if (value.token !== undefined && typeof value.token !== "string") {
    return { ok: false, status: 400, error: "bad_token", message: "Session token must be a string" };
  }

  const name = cleanName(value.name);
  if (!name || name.length > 20) {
    return { ok: false, status: 400, error: "bad_name", reason: "name", message: "Name must be 1-20 characters" };
  }

  const w = Number(value.w);
  const h = Number(value.h);
  const mineCount = Number(value.mineCount);
  if (!Number.isInteger(w) || !Number.isInteger(h) || !Number.isInteger(mineCount)) {
    return { ok: false, status: 400, error: "bad_preset", reason: "custom", message: "Board dimensions must be integers" };
  }

  const preset = presetKeyForConfig({ w, h, mineCount });
  if (!preset) {
    return { ok: false, status: 400, error: "bad_preset", reason: "custom", message: "Custom boards are not leaderboard eligible" };
  }

  const mode = value.mode;
  if (mode !== "standard" && mode !== "noguess") {
    return { ok: false, status: 400, error: "bad_mode", message: "Mode must be standard or noguess" };
  }
  if (mode === "noguess" && !NOGUESS_PRESETS.includes(preset)) {
    return { ok: false, status: 400, error: "bad_mode", reason: "custom", message: "No-guess leaderboard is expert-only" };
  }

  if (value.assistUsed === true) {
    return { ok: false, status: 400, error: "assist_used", reason: "assist", message: "Assisted games are not leaderboard eligible" };
  }

  const timeMs = Number(value.timeMs);
  if (!Number.isSafeInteger(timeMs) || timeMs <= 0 || timeMs > MAX_SUBMITTED_TIME_MS) {
    return { ok: false, status: 400, error: "bad_time", message: "Time must be a positive integer under 24 hours" };
  }

  return {
    ok: true,
    value: {
      preset,
      mode,
      timeMs,
      name,
      token: cleanToken(value.token),
      finishedAt: Date.now()
    }
  };
}

async function handleLeaderboardSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_json", message: "Invalid JSON" }, 400);
  }

  const validation = validateSubmitPayload(body);
  if (!validation.ok) {
    return json({ error: validation.error, reason: validation.reason, message: validation.message }, validation.status);
  }

  const key = rateLimitKey(request, validation.value.token);
  if (!submitRateAllowed(key, Date.now())) {
    return json({ error: "rate_limited", message: "Too many leaderboard submissions" }, 429, { "Retry-After": "60" });
  }

  const { preset, mode, timeMs, name, token, finishedAt } = validation.value;
  const leaderboard = env.LEADERBOARD.getByName("global");
  if (token) {
    await leaderboard.renameToken(token, name);
  }
  // Offline solo games have no server-owned board or clock; solo clients self-report
  // times for this friends-only leaderboard, while the server still validates eligibility.
  const result = await leaderboard.recordWin({
    preset,
    mode,
    timeMs,
    finishedAt,
    contributors: [{ name, token }]
  });
  return json(result);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return text("ok");
    }

    if (request.method === "GET" && url.pathname === "/leaderboard") {
      const boards = await env.LEADERBOARD.getByName("global").getBoards();
      return json(boards, 200, { "Cache-Control": "public, max-age=30" });
    }

    if (request.method === "POST" && url.pathname === "/leaderboard/submit") {
      return handleLeaderboardSubmit(request, env);
    }

    if (request.method === "GET" && url.pathname === "/leaderboard-debug" && env.LEADERBOARD_DEBUG === "true") {
      const snapshot = await env.LEADERBOARD.getByName("global").debugSnapshot();
      return json(snapshot, 200, { "Cache-Control": "no-store", "X-Temporary-Debug-Route": "leaderboard-migration" });
    }

    const match = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && match) {
      const code = match[1];
      if (!isValidRoomCode(code)) {
        return text("bad room code", 400);
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return text("websocket upgrade required", 426);
      }
      return env.GAME.getByName(code).fetch(request);
    }

    return text("not found", 404);
  }
};
