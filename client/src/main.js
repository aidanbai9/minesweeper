import { PRESETS, normalizeConfig } from "../engine/index.js";
import { createLocalTransport } from "./local.js";
import { createNetTransport } from "./net.js";
import { setupInput } from "./input.js";
import { mountGame, stateFromSnapshot } from "./render.js";
import { HTTP_BASE } from "./config.js";

const root = document.querySelector("#app");
const STORAGE_KEY = "minesweeper:last-config";
const PREFS_STORAGE_KEY = "minesweeper:prefs";
const LAST_NAME_KEY = "minesweeper:lastName";
const SESSION_NAME_KEY = "minesweeper:sessionName";
const SESSION_TOKEN_KEY = "minesweeper:token";
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
let activeTransport = null;
let activeCleanup = null;
let prefs = loadPrefs();
let bootToken = 0;
const sessionToken = createSessionToken();

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

function createSessionToken() {
  const token = crypto.randomUUID();
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  return token;
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

function cleanName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 20);
}

function persistName(name) {
  sessionStorage.setItem(SESSION_NAME_KEY, name);
  localStorage.setItem(LAST_NAME_KEY, name);
}

function promptForOnlineName() {
  const activeName = cleanName(sessionStorage.getItem(SESSION_NAME_KEY));
  if (activeName) {
    return Promise.resolve(activeName);
  }

  return new Promise((resolve) => {
    root.innerHTML = `
      <main class="menu">
        <section class="menu-panel name-panel">
          <h1>Player name</h1>
          <form class="name-form">
            <label>Name <input name="name" type="text" maxlength="20" autocomplete="nickname"></label>
            <p class="name-error" hidden>Enter 1-20 characters.</p>
            <button type="submit">Join room</button>
          </form>
        </section>
      </main>
    `;

    const form = root.querySelector(".name-form");
    const input = form.querySelector('[name="name"]');
    const error = form.querySelector(".name-error");
    input.value = localStorage.getItem(LAST_NAME_KEY) || "";

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = cleanName(input.value);
      if (!name) {
        error.hidden = false;
        input.focus();
        return;
      }
      persistName(name);
      resolve(name);
    });

    input.addEventListener("input", () => {
      error.hidden = true;
    });
    input.focus();
    input.select();
  });
}

function normalizePrefs(value = {}) {
  const cellSize = ["100", "150", "200"].includes(String(value.cellSize)) ? String(value.cellSize) : "100";
  const theme = ["classic", "flat"].includes(String(value.theme)) ? String(value.theme) : "classic";
  return {
    cellSize,
    theme,
    autoChord: value.autoChord === true,
    autoFlag: value.autoFlag === true
  };
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
  document.documentElement.dataset.theme = prefs.theme;
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
          <button data-preset="zhenghua">Zhenghua</button>
        </div>
        <div class="custom-grid">
          <label>Width <input name="w" type="number" min="5" max="60" value="${last.w}"></label>
          <label>Height <input name="h" type="number" min="5" max="60" value="${last.h}"></label>
          <label>Mines <input name="m" type="number" min="1" value="${last.mineCount}"></label>
        </div>
        <div class="action-row">
          <button data-action="solo">Play solo (ranked)</button>
          <button data-action="offline">Play offline (UNRANKED)</button>
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
    if (action === "offline") {
      hash.set("s", randomSeed());
    } else {
      hash.set("r", generateRoomCode());
    }
    hash.set("w", config.w);
    hash.set("h", config.h);
    hash.set("m", config.mineCount);
    setHash(hash);

    if (action === "together") {
      await navigator.clipboard?.writeText(location.href).catch(() => {});
    }
  });
}

async function fetchLeaderboard() {
  const response = await fetch(`${HTTP_BASE}/leaderboard`, { mode: "cors" });
  if (!response.ok) {
    throw new Error("Leaderboard request failed");
  }
  return response.json();
}

function bootTransport(transport, options = {}) {
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
      online: options.online === true,
      onLeaderboardOpen: fetchLeaderboard,
      onPrefsChange: updatePrefs,
      onRename(name) {
        const cleaned = cleanName(name);
        if (!cleaned) {
          return;
        }
        persistName(cleaned);
        transport.rename?.(cleaned);
      },
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
  transport.on("events", (message) => {
    api?.applyEvents(message);
  });
  transport.on("peer_join", (peer) => {
    api?.upsertPeer(peer);
  });
  transport.on("peer_rename", ({ playerId, name }) => {
    api?.renamePeer(playerId, name);
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
  transport.on("win_recorded", (outcome) => {
    api?.setWinOutcome(outcome);
  });
  transport.on("win_ineligible", (outcome) => {
    api?.setWinOutcome(outcome);
  });
  transport.on("error", (error) => {
    console.warn("server error", error);
    api?.showNotice(error.message || "Server rejected that change.");
  });
  transport.connect();
}

async function bootFromHash() {
  const token = ++bootToken;
  const params = paramsFromHash();
  if (params.has("s")) {
    const config = configFromParams(params, true);
    saveConfig(config);
    bootTransport(createLocalTransport(config), { online: false });
    return;
  }

  if (params.has("r")) {
    const code = params.get("r");
    const config = params.has("w") || params.has("h") || params.has("m") ? configFromParams(params, false) : null;
    if (config) {
      saveConfig(config);
    }
    const name = await promptForOnlineName();
    if (token !== bootToken) {
      return;
    }
    bootTransport(createNetTransport({ code, config: config || storedConfig(), name, token: sessionToken }), {
      online: true
    });
    return;
  }

  renderMenu();
}

window.addEventListener("hashchange", () => {
  void bootFromHash();
});

applyPrefs();
void bootFromHash();
