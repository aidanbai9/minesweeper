import { PRESETS, normalizeConfig } from "../engine/index.js";
import { createLocalTransport } from "./local.js";
import { createNetTransport } from "./net.js";
import { setupInput } from "./input.js";
import { mountGame, stateFromSnapshot } from "./render.js";

const root = document.querySelector("#app");
const STORAGE_KEY = "minesweeper:last-config";
const PREFS_STORAGE_KEY = "minesweeper:prefs";
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
let activeTransport = null;
let activeCleanup = null;
let prefs = loadPrefs();

function randomSeed() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
}

function generateRoomCode(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  }
  return code;
}

function paramsFromHash() {
  return new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
}

function configFromParams(params, includeSeed = false) {
  const base = {
    w: params.get("w"),
    h: params.get("h"),
    mineCount: params.get("m")
  };
  if (includeSeed) {
    base.seed = params.get("s") || params.get("seed") || randomSeed();
  }
  return normalizeConfig(base);
}

function storedConfig() {
  try {
    return normalizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || PRESETS.beginner);
  } catch {
    return normalizeConfig(PRESETS.beginner);
  }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ w: config.w, h: config.h, mineCount: config.mineCount }));
}

function normalizePrefs(value = {}) {
  const cellSize = ["100", "150", "200"].includes(String(value.cellSize)) ? String(value.cellSize) : "100";
  return { cellSize };
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    const normalized = normalizePrefs(raw ? JSON.parse(raw) || {} : {});
    if (raw) {
      const serialized = JSON.stringify(normalized);
      if (raw !== serialized) {
        try {
          localStorage.setItem(PREFS_STORAGE_KEY, serialized);
        } catch {}
      }
    }
    return normalized;
  } catch {
    return normalizePrefs();
  }
}

function applyPrefs() {
  const scale = { 100: "1", 150: "1.5", 200: "2" }[prefs.cellSize] || "1";
  document.documentElement.style.setProperty("--scale", scale);
}

function updatePrefs(nextPrefs) {
  prefs = normalizePrefs({ ...prefs, ...nextPrefs });
  localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  applyPrefs();
}

function setHash(params) {
  location.hash = params.toString();
}

function renderMenu() {
  activeCleanup?.();
  activeCleanup = null;
  activeTransport?.close();
  activeTransport = null;
  const last = storedConfig();
  root.innerHTML = `
    <main class="menu">
      <section class="menu-panel">
        <h1>Minesweeper</h1>
        <div class="preset-row">
          <button data-preset="beginner">Beginner</button>
          <button data-preset="intermediate">Intermediate</button>
          <button data-preset="expert">Expert</button>
        </div>
        <div class="custom-grid">
          <label>Width <input name="w" type="number" min="5" max="60" value="${last.w}"></label>
          <label>Height <input name="h" type="number" min="5" max="60" value="${last.h}"></label>
          <label>Mines <input name="m" type="number" min="1" value="${last.mineCount}"></label>
        </div>
        <div class="action-row">
          <button data-action="solo">Play solo</button>
          <button data-action="together">Play together</button>
        </div>
      </section>
    </main>
  `;

  const panel = root.querySelector(".menu-panel");
  const w = panel.querySelector('[name="w"]');
  const h = panel.querySelector('[name="h"]');
  const m = panel.querySelector('[name="m"]');

  function currentConfig() {
    return normalizeConfig({ w: w.value, h: h.value, mineCount: m.value, seed: randomSeed() });
  }

  panel.addEventListener("click", async (event) => {
    const preset = event.target.closest("[data-preset]")?.dataset.preset;
    if (preset) {
      const config = PRESETS[preset];
      w.value = config.w;
      h.value = config.h;
      m.value = config.mineCount;
      saveConfig(config);
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) {
      return;
    }

    const config = currentConfig();
    saveConfig(config);
    const hash = new URLSearchParams();
    hash.set(action === "solo" ? "s" : "r", action === "solo" ? randomSeed() : generateRoomCode());
    hash.set("w", config.w);
    hash.set("h", config.h);
    hash.set("m", config.mineCount);
    setHash(hash);

    if (action === "together") {
      await navigator.clipboard?.writeText(location.href).catch(() => {});
    }
  });
}

function bootTransport(transport) {
  activeCleanup?.();
  activeTransport?.close();
  activeTransport = transport;
  let api = null;
  let detachInput = null;

  activeCleanup = () => {
    detachInput?.();
    api?.destroy();
  };

  function remount(snapshot) {
    detachInput?.();
    api?.destroy();
    const state = stateFromSnapshot(snapshot);
    api = mountGame(root, state, {
      onReset: () => transport.reset(),
      prefs,
      onPrefsChange: updatePrefs,
      onReconfig(config) {
        saveConfig(config);
        transport.reconfig(config);
      }
    });
    detachInput = setupInput(api.board, api, transport);
  }

  transport.on("snapshot", (snapshot) => {
    remount(snapshot);
  });
  transport.on("events", (events) => {
    api?.applyEvents(events);
  });
  transport.on("peer_join", (peer) => {
    api?.upsertPeer(peer);
  });
  transport.on("peer_leave", (playerId) => {
    api?.removePeer(playerId);
  });
  transport.on("cursor", ({ playerId, idx }) => {
    api?.setCursor(playerId, idx);
  });
  transport.on("connection", ({ reconnecting }) => {
    api?.setBanner(reconnecting);
  });
  transport.on("notice", (text) => {
    api?.showNotice(text);
  });
  transport.on("error", (error) => {
    console.warn("server error", error);
  });
  transport.connect();
}

function bootFromHash() {
  const params = paramsFromHash();
  if (params.has("s")) {
    const config = configFromParams(params, true);
    saveConfig(config);
    bootTransport(createLocalTransport(config));
    return;
  }

  if (params.has("r")) {
    const code = params.get("r");
    const config = params.has("w") || params.has("h") || params.has("m") ? configFromParams(params, false) : null;
    if (config) {
      saveConfig(config);
    }
    bootTransport(createNetTransport({ code, config: config || storedConfig() }));
    return;
  }

  renderMenu();
}

window.addEventListener("hashchange", () => {
  bootFromHash();
});

applyPrefs();
bootFromHash();
