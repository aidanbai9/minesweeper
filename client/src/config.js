function normalizeWsBase(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "ws://localhost:8787";
  }
  if (raw.startsWith("http://")) {
    return raw.replace(/^http:\/\//, "ws://").replace(/\/$/, "");
  }
  if (raw.startsWith("https://")) {
    return raw.replace(/^https:\/\//, "wss://").replace(/\/$/, "");
  }
  return raw.replace(/\/$/, "");
}

export const WS_BASE = normalizeWsBase(window.__WS_BASE__);
export const HTTP_BASE = WS_BASE.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

// Flip to true to restore the existing chat UI without changing chat plumbing.
export const CHAT_ENABLED = false;

// Flip to true to restore the existing no-guess UI entry points once generation is ready.
export const NO_GUESS_ENABLED = false;
