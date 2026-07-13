import { assertConfig, normalizeConfig } from "../../engine/src/index.js";

export const VERSION = 1;
export const ACTION_TYPES = new Set(["REVEAL", "FLAG", "CHORD"]);
export const CLIENT_TYPES = new Set(["HELLO", "ACTION", "CURSOR", "RESET", "RECONFIG"]);

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonMessage(raw) {
  if (typeof raw !== "string") {
    return { ok: false, code: "bad_json", message: "Message must be JSON text" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, code: "bad_json", message: "Invalid JSON" };
  }
}

export function validateInbound(value, totalCells) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "bad_message", message: "Message must be an object" };
  }
  if (value.v !== VERSION) {
    return { ok: false, code: "bad_version", message: "Unsupported protocol version" };
  }
  if (!CLIENT_TYPES.has(value.t)) {
    return { ok: false, code: "bad_type", message: "Unknown message type" };
  }

  if (value.t === "HELLO") {
    if (value.name !== undefined && typeof value.name !== "string") {
      return { ok: false, code: "bad_name", message: "Name must be a string" };
    }
    return { ok: true, value: { v: VERSION, t: "HELLO", name: cleanName(value.name) } };
  }

  if (value.t === "RESET") {
    return { ok: true, value: { v: VERSION, t: "RESET" } };
  }

  if (value.t === "RECONFIG") {
    const config = value.config;
    if (!isPlainObject(config)) {
      return { ok: false, code: "bad_config", message: "Config must be an object" };
    }
    if (!Number.isInteger(config.w) || !Number.isInteger(config.h) || !Number.isInteger(config.mineCount)) {
      return { ok: false, code: "bad_config", message: "Config values must be integers" };
    }
    try {
      const normalized = normalizeConfig(config);
      if (normalized.w !== config.w || normalized.h !== config.h || normalized.mineCount !== config.mineCount) {
        return { ok: false, code: "bad_config", message: "Config is outside the supported range" };
      }
      assertConfig(normalized);
      return {
        ok: true,
        value: {
          v: VERSION,
          t: "RECONFIG",
          config: { w: normalized.w, h: normalized.h, mineCount: normalized.mineCount }
        }
      };
    } catch (error) {
      return { ok: false, code: "bad_config", message: error?.message || "Invalid config" };
    }
  }

  if (value.t === "CURSOR") {
    if (!Number.isInteger(value.idx) || value.idx < -1 || value.idx >= totalCells) {
      return { ok: false, code: "bad_idx", message: "Cursor index is outside the board" };
    }
    return { ok: true, value: { v: VERSION, t: "CURSOR", idx: value.idx } };
  }

  const action = value.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { ok: false, code: "bad_action", message: "Action must be an object" };
  }
  if (!ACTION_TYPES.has(action.type)) {
    return { ok: false, code: "bad_action", message: "Unknown action type" };
  }
  if (!Number.isInteger(action.idx) || action.idx < 0 || action.idx >= totalCells) {
    return { ok: false, code: "bad_idx", message: "Action index is outside the board" };
  }

  return { ok: true, value: { v: VERSION, t: "ACTION", action: { type: action.type, idx: action.idx } } };
}

export function cleanName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name.trim().replace(/\s+/g, " ").slice(0, 24);
}

export function encode(message) {
  return JSON.stringify({ v: VERSION, ...message });
}

export function errorMessage(code, message) {
  return encode({ t: "ERROR", code, message });
}
