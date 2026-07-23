import { PRESETS, isNoGuessConfig, normalizeConfig } from "../engine/index.js";
import { createLocalTransport } from "./local.js";
import { createNetTransport } from "./net.js";
import { setupInput } from "./input.js";
import { mountGame, stateFromSnapshot } from "./render.js";
import { HTTP_BASE, NO_GUESS_ENABLED } from "./config.js";

const root = document.querySelector("#app");
const STORAGE_KEY = "minesweeper:last-config";
const PREFS_STORAGE_KEY = "minesweeper:prefs";
const LAST_NAME_KEY = "minesweeper:lastName";
const SESSION_NAME_KEY = "minesweeper:sessionName";
const SESSION_TOKEN_KEY = "minesweeper:token";
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const DEFAULT_THEME_OPTIONS = [
  ["classic", "Classic"]
];
let activeTransport = null;
let activeCleanup = null;
let themeOptions = DEFAULT_THEME_OPTIONS;
let prefs = normalizePrefs();
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
    mineCount: params.get("m"),
    noGuess: NO_GUESS_ENABLED && (params.get("ng") === "1" || params.get("noguess") === "1"),
    noGuessVerified: NO_GUESS_ENABLED && params.get("ngv") === "1",
    noGuessSafeIdx: NO_GUESS_ENABLED ? Number.parseInt(params.get("ngi") || "-1", 10) : -1
  };
  if (includeSeed) {
    base.seed = params.get("s") || params.get("seed") || randomSeed();
  }
  const normalized = normalizeConfig(base);
  return {
    ...normalized,
    noGuess: base.noGuess && isNoGuessConfig(normalized),
    noGuessVerified: base.noGuessVerified,
    noGuessSafeIdx: Number.isInteger(base.noGuessSafeIdx) ? base.noGuessSafeIdx : -1
  };
}

function storedConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || PRESETS.beginner;
    const normalized = normalizeConfig(raw);
    return { ...normalized, noGuess: NO_GUESS_ENABLED && raw.noGuess === true && isNoGuessConfig(normalized) };
  } catch {
    return { ...normalizeConfig(PRESETS.beginner), noGuess: false };
  }
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      w: normalized.w,
      h: normalized.h,
      mineCount: normalized.mineCount,
      noGuess: NO_GUESS_ENABLED && config.noGuess === true && isNoGuessConfig(normalized)
    })
  );
}

function cleanName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function isValidName(name) {
  return Boolean(name) && name.length <= 20;
}

function persistName(name) {
  sessionStorage.setItem(SESSION_NAME_KEY, name);
  localStorage.setItem(LAST_NAME_KEY, name);
}

function promptForPlayerName(buttonText = "Join room") {
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
            <label>Name <input name="name" type="text" autocomplete="nickname"></label>
            <p class="name-error" hidden>Enter 1-20 characters.</p>
            <button type="submit">${buttonText}</button>
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
      if (!isValidName(name)) {
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

function promptForOnlineName() {
  return promptForPlayerName("Join room");
}

function promptForSoloName() {
  return promptForPlayerName("Start game");
}

function normalizeThemeOptions(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_THEME_OPTIONS;
  }
  const options = value
    .map((theme) => {
      if (!theme || typeof theme !== "object" || Array.isArray(theme)) {
        return null;
      }
      const id = String(theme.id || "").trim();
      const label = String(theme.label || "").trim();
      if (!/^[a-z0-9_-]+$/.test(id) || !label) {
        return null;
      }
      return [id, label];
    })
    .filter(Boolean);
  return options.length ? options : DEFAULT_THEME_OPTIONS;
}

async function loadThemeOptions() {
  try {
    const response = await fetch("./themes.json", { cache: "no-cache" });
    if (!response.ok) {
      return DEFAULT_THEME_OPTIONS;
    }
    return normalizeThemeOptions(await response.json());
  } catch {
    return DEFAULT_THEME_OPTIONS;
  }
}

function loadThemeStyles(themes) {
  return Promise.all(
    themes.map(
      ([theme]) =>
        new Promise((resolve) => {
          if (document.querySelector(`link[data-theme-css="${theme}"]`)) {
            resolve();
            return;
          }
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `./styles/themes/${theme}.css`;
          link.dataset.themeCss = theme;
          link.onload = resolve;
          link.onerror = resolve;
          document.head.append(link);
        })
    )
  );
}

function normalizePrefs(value = {}, themes = themeOptions) {
  const cellSize = ["100", "150", "200"].includes(String(value.cellSize)) ? String(value.cellSize) : "100";
  const themeIds = new Set(themes.map(([theme]) => theme));
  const theme = themeIds.has(String(value.theme)) ? String(value.theme) : themes[0]?.[0] || "classic";
  return {
    cellSize,
    theme,
    autoChord: value.autoChord === true,
    autoFlag: value.autoFlag === true
  };
}

function loadPrefs(themes = themeOptions) {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    const normalized = normalizePrefs(raw ? JSON.parse(raw) || {} : {}, themes);
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

function replaceHash(params) {
  history.replaceState(null, "", `${location.pathname}${location.search}#${params.toString()}`);
}

function setGameHash(config, play) {
  const hash = new URLSearchParams();
  if (play === "alone") {
    hash.set("s", randomSeed());
  } else {
    hash.set("r", generateRoomCode());
  }
  hash.set("w", config.w);
  hash.set("h", config.h);
  hash.set("m", config.mineCount);
  if (config.noGuess) {
    hash.set("ng", "1");
  }
  replaceHash(hash);
  void bootFromHash();
}

function renderEntryMenu() {
  activeCleanup?.();
  activeCleanup = null;
  activeTransport?.close();
  activeTransport = null;
  renderConfigMenu();
}

function renderConfigMenu() {
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
        ${
          NO_GUESS_ENABLED
            ? `
              <label class="menu-checkbox">
                <input name="noGuess" type="checkbox"${last.noGuess ? " checked" : ""}>
                <span>No-guessing mode</span>
              </label>
              <p class="noguess-note" data-noguess-note>No-guess is currently expert-only.</p>
            `
            : ""
        }
        <div class="action-row">
          <button data-action="start">Start game</button>
          <button data-action="back">Back</button>
        </div>
      </section>
    </main>
  `;

  const panel = root.querySelector(".menu-panel");
  const w = panel.querySelector('[name="w"]');
  const h = panel.querySelector('[name="h"]');
  const m = panel.querySelector('[name="m"]');
  const noGuess = panel.querySelector('[name="noGuess"]');
  const noGuessNote = panel.querySelector("[data-noguess-note]");

  function syncNoGuessControl() {
    if (!noGuess) {
      return;
    }
    const config = normalizeConfig({ w: w.value, h: h.value, mineCount: m.value });
    const available = NO_GUESS_ENABLED && isNoGuessConfig(config);
    noGuess.disabled = !available;
    noGuess.closest(".menu-checkbox")?.classList.toggle("disabled", !available);
    if (noGuessNote) {
      noGuessNote.hidden = available;
    }
    if (!available) {
      noGuess.checked = false;
    }
  }

  function currentConfig() {
    const normalized = normalizeConfig({ w: w.value, h: h.value, mineCount: m.value, seed: randomSeed() });
    return {
      ...normalized,
      noGuess: NO_GUESS_ENABLED && noGuess?.checked === true && isNoGuessConfig(normalized)
    };
  }

  syncNoGuessControl();

  panel.addEventListener("click", async (event) => {
    const preset = event.target.closest("[data-preset]")?.dataset.preset;
    if (preset) {
      const config = PRESETS[preset];
      w.value = config.w;
      h.value = config.h;
      m.value = config.mineCount;
      syncNoGuessControl();
      saveConfig({ ...config, noGuess: NO_GUESS_ENABLED && noGuess?.checked === true && isNoGuessConfig(config) });
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) {
      return;
    }
    if (action === "back") {
      renderEntryMenu();
      return;
    }

    const config = currentConfig();
    saveConfig(config);
    renderPlayChoice({ config });
  });

  for (const input of [w, h, m]) {
    input.addEventListener("input", syncNoGuessControl);
  }
}

function renderPlayChoice({ config }) {
  root.innerHTML = `
    <main class="menu">
      <section class="menu-panel">
        <h1>Start game</h1>
        <p class="noguess-note">Play alone runs entirely on this device. You cannot invite others into that game; start a new game to play together.</p>
        <div class="action-row">
          <button data-play="alone">Play alone</button>
          <button data-play="with-others">Play with others</button>
          <button data-play="back">Back</button>
        </div>
      </section>
    </main>
  `;

  root.querySelector(".menu-panel").addEventListener("click", async (event) => {
    const play = event.target.closest("[data-play]")?.dataset.play;
    if (!play) {
      return;
    }
    if (play === "back") {
      renderConfigMenu();
      return;
    }
    if (play === "alone") {
      await promptForSoloName();
    }
    setGameHash(config, play);
    if (play === "with-others") {
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

async function submitSoloWin(state, { name, token }) {
  const timeMs = Math.trunc((state.endedAt || Date.now()) - (state.startedAt || state.endedAt || Date.now()));
  const response = await fetch(`${HTTP_BASE}/leaderboard/submit`, {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preset: "",
      mode: state.noGuess === true ? "noguess" : "standard",
      timeMs,
      name,
      token,
      assistUsed: Boolean(state.assistTainted),
      w: state.w,
      h: state.h,
      mineCount: state.mineCount
    })
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    return { t: "WIN_RECORDED", ranked: body.ranked === true, rank: body.rank, reason: body.reason, cap: body.cap };
  }
  return { t: "WIN_INELIGIBLE", reason: body.reason || body.error || "custom" };
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
      themes: themeOptions,
      onRename(name) {
        const cleaned = cleanName(name);
        if (!isValidName(cleaned)) {
          api?.setRenameError("Enter 1-20 characters.");
          return;
        }
        persistName(cleaned);
        api?.setRenameStatus("");
        transport.rename?.(cleaned);
      },
      onReconfig(config) {
        saveConfig(config);
        transport.reconfig(config);
      },
      onChatSend(text) {
        transport.sendChat?.(text);
      },
      onWin: options.onWin
        ? (state) => options.onWin(state, {
            name: cleanName(sessionStorage.getItem(SESSION_NAME_KEY)) || options.name || "Player",
            token: sessionToken
          })
        : null
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
    if (api?.getState().you?.playerId === playerId) {
      api?.setRenameStatus("Username changed.");
    }
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
  transport.on("chat", (message) => {
    api?.addChatMessage(message);
  });
  transport.on("win_recorded", (outcome) => {
    api?.setWinOutcome(outcome);
  });
  transport.on("win_ineligible", (outcome) => {
    api?.setWinOutcome(outcome);
  });
  transport.on("error", (error) => {
    console.warn("server error", error);
    if (error.code === "bad_name") {
      api?.setRenameError(error.message || "Enter 1-20 characters.");
      return;
    }
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
    const name = await promptForSoloName();
    if (token !== bootToken) {
      return;
    }
    bootTransport(createLocalTransport(config, { name }), {
      online: false,
      name,
      onWin: submitSoloWin
    });
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

  renderEntryMenu();
}

window.addEventListener("hashchange", () => {
  void bootFromHash();
});

void loadThemeOptions().then((options) => {
  themeOptions = options;
  void loadThemeStyles(themeOptions).then(() => {
    prefs = loadPrefs(themeOptions);
    applyPrefs();
    void bootFromHash();
  });
});
