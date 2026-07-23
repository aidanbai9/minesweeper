import { createChrome } from "./chrome.js";
import { createPresence } from "./presence.js";
import { CHAT_ENABLED, NO_GUESS_ENABLED } from "./config.js";
import { AUTO_FLAG, PRESETS, applyAction, isNoGuessConfig, isNoGuessPreset } from "../engine/index.js";

const STATUS = { PENDING: 0, PLAYING: 1, WON: 2, LOST: 3 };
const CELL_SIZE_OPTIONS = ["100", "150", "200"];
const PENDING_TIMEOUT_MS = 1500;
const PRESET_OPTIONS = [
  ["beginner", "Beginner"],
  ["intermediate", "Intermediate"],
  ["expert", "Expert"],
  ["zhenghua", "Zhenghua"],
  ["custom", "Custom"]
];
const LEADERBOARD_PRESETS = PRESET_OPTIONS.filter(([key]) => key !== "custom");
const LEADERBOARD_MODES = NO_GUESS_ENABLED ? [
  ["standard", "Standard"],
  ["noguess", "No-guess"]
] : [["standard", "Standard"]];

function checked(value, expected) {
  return value === expected ? " checked" : "";
}

function presetForConfig(config) {
  for (const [key] of PRESET_OPTIONS) {
    if (key === "custom") {
      continue;
    }
    const preset = PRESETS[key];
    if (preset.w === config.w && preset.h === config.h && preset.mineCount === config.mineCount) {
      return key;
    }
  }
  return "custom";
}

function presetLabel(key) {
  return PRESET_OPTIONS.find(([preset]) => preset === key)?.[1] || "Custom";
}

function modeLabel(noGuess) {
  return NO_GUESS_ENABLED && noGuess === true ? "No-guess" : "Standard";
}

function formatPreciseMs(timeMs) {
  return (Math.max(0, timeMs) / 1000).toFixed(2);
}

function formatRank(rank) {
  const n = Number(rank);
  if (!Number.isInteger(n) || n < 1) {
    return "";
  }
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
}

function formatChatTime(ts) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

function normalizedEvents(events) {
  return JSON.stringify(Array.isArray(events) ? events : []);
}

function settingsHtml(state, prefs, options = {}) {
  const preset = presetForConfig(state);
  const themeOptions = options.themes || [["classic", "Classic"]];
  return `
    <div class="settings-backdrop" hidden>
      <section class="settings-dialog" role="dialog" aria-modal="true" aria-label="settings">
        <div class="settings-title-row">
          <h2>Settings</h2>
          <button class="settings-close" type="button" data-settings-close aria-label="close">&times;</button>
        </div>
        <section class="settings-section">
          <h3>Display</h3>
          <fieldset>
            <legend>Cell size</legend>
            <div class="segmented">
              ${CELL_SIZE_OPTIONS.map(
                (size) => `
                  <label>
                    <input type="radio" name="cellSize" value="${size}"${checked(prefs.cellSize, size)}>
                    <span>${size}%</span>
                  </label>
                `
              ).join("")}
            </div>
          </fieldset>
          <fieldset>
            <legend>Theme</legend>
            <div class="segmented">
              ${themeOptions.map(
                ([theme, label]) => `
                  <label>
                    <input type="radio" name="theme" value="${theme}"${checked(prefs.theme, theme)}>
                    <span>${label}</span>
                  </label>
                `
              ).join("")}
            </div>
          </fieldset>
          ${
            options.canRename
              ? `
                <form class="rename-form" data-rename-form>
                  <label>Change username <input name="displayName" type="text" autocomplete="nickname"></label>
                  <p class="name-error" data-rename-error hidden>Enter 1-20 characters.</p>
                  <p class="name-status" data-rename-status hidden></p>
                  <button type="submit">Change username</button>
                </form>
              `
              : ""
          }
          <fieldset>
            <legend>Assists</legend>
            <div class="assist-options">
              <label>
                <input type="checkbox" name="autoChord"${checked(prefs.autoChord, true)}>
                <span>Auto-chord</span>
              </label>
              <label>
                <input type="checkbox" name="autoFlag"${checked(prefs.autoFlag, true)}>
                <span>Auto-flag</span>
              </label>
            </div>
            <p class="assist-note">Assists disqualify the shared board from leaderboard ranking.</p>
          </fieldset>
        </section>
        <section class="settings-section">
          <h3>Controls</h3>
          <dl class="controls-reference">
            <div><dt>Left click</dt><dd>reveal, or chord on a number</dd></div>
            <div><dt>Right click</dt><dd>flag</dd></div>
            <div><dt>Middle click</dt><dd>chord</dd></div>
            <div><dt>Shift + click</dt><dd>flag, or chord on a number</dd></div>
            <div><dt>Space</dt><dd>flag, or chord on a number</dd></div>
          </dl>
        </section>
        <section class="settings-section">
          <h3>Game</h3>
          <fieldset>
            <legend>Preset</legend>
            <div class="settings-preset-row">
              ${PRESET_OPTIONS.map(
                ([key, label]) => `
                  <label>
                    <input type="radio" name="preset" value="${key}"${checked(preset, key)}>
                    <span>${label}</span>
                  </label>
                `
              ).join("")}
            </div>
          </fieldset>
          <div class="settings-custom-grid">
            <label>Width <input data-config-input name="settings-w" type="number" min="5" max="60" step="1" value="${state.w}"></label>
            <label>Height <input data-config-input name="settings-h" type="number" min="5" max="60" step="1" value="${state.h}"></label>
            <label>Mines <input data-config-input name="settings-m" type="number" min="1" step="1" value="${state.mineCount}"></label>
          </div>
          <p class="mine-range" data-role="mine-range"></p>
          ${
            NO_GUESS_ENABLED
              ? `
                <label class="game-mode-toggle">
                  <input name="settings-no-guess" type="checkbox"${state.noGuess ? " checked" : ""}${isNoGuessConfig(state) ? "" : " disabled"}>
                  <span>No-guessing mode</span>
                </label>
                <p class="noguess-note" data-settings-noguess-note${isNoGuessConfig(state) ? " hidden" : ""}>No-guess is currently expert-only.</p>
              `
              : ""
          }
          <div class="confirm-row" data-role="confirm-reconfig" hidden>
            <span>This starts a new game for everyone in the room. Continue?</span>
            <button type="button" data-confirm-reconfig>Continue</button>
            <button type="button" data-cancel-reconfig>Cancel</button>
          </div>
          <button class="apply-button" type="button" data-apply-reconfig>Apply / New game</button>
        </section>
      </section>
    </div>
  `;
}

function resultHtml() {
  return `
    <div class="result-backdrop" hidden>
      <section class="result-dialog" role="dialog" aria-modal="true" aria-label="game result">
        <div class="settings-title-row">
          <h2 data-result-title></h2>
          <button class="result-close" type="button" data-result-close aria-label="close">&times;</button>
        </div>
        <p class="result-time" data-result-time></p>
        <p class="result-rank" data-result-rank></p>
      </section>
    </div>
  `;
}

function leaderboardHtml() {
  return `
    <div class="leaderboard-backdrop" hidden>
      <section class="leaderboard-dialog" role="dialog" aria-modal="true" aria-label="leaderboard">
        <div class="settings-title-row">
          <h2>Leaderboard</h2>
          <button class="leaderboard-close" type="button" data-leaderboard-close aria-label="close">&times;</button>
        </div>
        <div class="leaderboard-tabs" data-leaderboard-tabs></div>
        <div class="leaderboard-tabs" data-leaderboard-mode-tabs></div>
        <div class="leaderboard-body" data-leaderboard-body></div>
      </section>
    </div>
  `;
}

function inputInteger(input) {
  if (!input.value.trim()) {
    return NaN;
  }
  const value = Number(input.value);
  return Number.isInteger(value) ? value : NaN;
}

function flagSvg() {
  return `
    <svg class="flag-svg" viewBox="0 0 16 16" aria-hidden="true">
      <path class="flag-pole" d="M5 3h1v9H5z"/>
      <path class="flag-base" d="M4 12h7v2H3v-1z"/>
      <path class="flag-cloth" d="M6 3l7 3-7 3z"/>
    </svg>
  `;
}

function correctFlagSvg() {
  return `
    ${flagSvg()}
    <svg class="correct-mark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3 3L13 4" fill="none" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function mineSvg(extra = "") {
  return `
    <svg class="mine-svg ${extra}" viewBox="0 0 16 16" aria-hidden="true">
      <path class="mine-spikes" d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13" stroke-width="1.5"/>
      <circle class="mine-body" cx="8" cy="8" r="4.5"/>
      <circle class="mine-highlight" cx="6.5" cy="6.5" r="1"/>
    </svg>
  `;
}

function wrongFlagSvg() {
  return `
    ${mineSvg()}
    <svg class="wrong-x" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 2l12 12M14 2L2 14" stroke-width="2"/>
    </svg>
  `;
}

export function stateFromSnapshot(snapshot) {
  const { w, h, mineCount } = snapshot.config;
  const total = w * h;
  const counts = new Int8Array(total);
  counts.fill(-1);
  const revealed = new Uint8Array(total);
  for (const cell of snapshot.revealed || []) {
    revealed[cell.idx] = 1;
    counts[cell.idx] = cell.count;
  }

  const flags = new Uint8Array(total);
  for (const flag of snapshot.flags || []) {
    flags[flag.idx] = flag.playerId + 1;
  }

  const mines = new Set(snapshot.mines || []);
  const wrongFlags = new Set();
  if (snapshot.status === STATUS.LOST && mines.size > 0) {
    for (const flag of snapshot.flags || []) {
      if (!mines.has(flag.idx)) {
        wrongFlags.add(flag.idx);
      }
    }
  }

  const peers = new Map();
  if (snapshot.you) {
    peers.set(snapshot.you.playerId, snapshot.you);
  }
  for (const peer of snapshot.peers || []) {
    peers.set(peer.playerId, peer);
  }

  return {
    seed: snapshot.config.seed || "",
    w,
    h,
    mineCount,
    noGuess: snapshot.noGuess === true,
    noGuessVerified: snapshot.config.noGuessVerified === true,
    noGuessSafeIdx: Number.isInteger(snapshot.config.noGuessSafeIdx) ? snapshot.config.noGuessSafeIdx : -1,
    status: snapshot.status,
    counts,
    revealed,
    flags,
    flagCount: (snapshot.flags || []).length,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    lostAt: snapshot.lostAt,
    mines,
    wrongFlags,
    you: snapshot.you,
    peers,
    winOutcome: null,
    leaderboardPending: false
  };
}

export function mountGame(root, initialState, handlers) {
  let state = initialState;
  let prefs = { cellSize: "100", theme: "classic", autoChord: false, autoFlag: false, ...(handlers.prefs || {}) };
  const chatEnabled = CHAT_ENABLED && handlers.online === true;
  let generating = false;
  let held = false;
  let chatCollapsed =
    chatEnabled && typeof matchMedia === "function" && matchMedia("(max-width: 35rem)").matches;
  let unreadChat = 0;
  let timer = 0;
  let renderFrame = 0;
  let renderChrome = false;
  const toastTimers = new Set();
  const pending = new Set();
  const pendingGroups = new Set();
  const dirtyCells = new Set();
  const optimisticFrames = new Map();

  root.innerHTML = `
    <div class="reconnect-banner" hidden>reconnecting...</div>
    <div class="toast-stack" aria-live="polite" aria-atomic="true"></div>
    <main class="shell">
      <div class="game-layout">
        <section class="mines-panel">
          <div class="top chrome"></div>
          <div class="board-frame">
            <div class="board" role="grid"></div>
          </div>
          <div class="peer-strip"></div>
        </section>
        ${
          chatEnabled
            ? `
              <section class="chat-panel" data-chat-panel>
                <button class="chat-toggle" type="button" data-chat-toggle aria-expanded="true">
                  <span data-chat-label>Chat</span>
                  <span class="chat-unread" data-chat-unread hidden></span>
                </button>
                <div class="chat-body" data-chat-body>
                  <div class="chat-messages" data-chat-messages aria-live="polite"></div>
                  <form class="chat-form" data-chat-form>
                    <textarea name="chat" rows="2" maxlength="500"></textarea>
                    <button type="submit">Send</button>
                  </form>
                  <p class="chat-notice" data-chat-notice hidden></p>
                </div>
              </section>
            `
            : ""
        }
      </div>
    </main>
    ${settingsHtml(state, prefs, {
      canRename: typeof handlers.onRename === "function",
      themes: handlers.themes,
      online: handlers.online === true
    })}
    ${resultHtml()}
    ${leaderboardHtml()}
  `;

  const banner = root.querySelector(".reconnect-banner");
  const toastStack = root.querySelector(".toast-stack");
  const settingsBackdrop = root.querySelector(".settings-backdrop");
  const resultBackdrop = root.querySelector(".result-backdrop");
  const leaderboardBackdrop = root.querySelector(".leaderboard-backdrop");
  const chrome = createChrome(root.querySelector(".chrome"), {
    onReset: handlers.onReset,
    onLeaderboard: openLeaderboard,
    onSettings: openSettings
  });
  const board = root.querySelector(".board");
  const peerStrip = root.querySelector(".peer-strip");
  const chatPanel = root.querySelector("[data-chat-panel]");
  const chatToggle = root.querySelector("[data-chat-toggle]");
  const chatBody = root.querySelector("[data-chat-body]");
  const chatUnread = root.querySelector("[data-chat-unread]");
  const chatMessages = root.querySelector("[data-chat-messages]");
  const chatForm = root.querySelector("[data-chat-form]");
  const chatInput = chatForm?.querySelector('textarea[name="chat"]');
  const chatNotice = root.querySelector("[data-chat-notice]");
  board.style.gridTemplateColumns = `repeat(${state.w}, var(--cell))`;
  board.style.gridTemplateRows = `repeat(${state.h}, var(--cell))`;

  const cellFragment = document.createDocumentFragment();
  const cells = Array.from({ length: state.w * state.h }, (_, idx) => {
    const cell = document.createElement("div");
    cell.className = "cell unrevealed";
    cell.dataset.idx = String(idx);
    cell.setAttribute("role", "gridcell");
    cellFragment.append(cell);
    return cell;
  });
  board.append(cellFragment);

  const presence = createPresence(cells, peerStrip);
  presence.setPeers([...state.peers.values()].filter((peer) => peer.playerId !== state.you?.playerId), state.you);

  function syncChatCollapsed() {
    if (!chatPanel) {
      return;
    }
    chatPanel.classList.toggle("collapsed", chatCollapsed);
    chatToggle?.setAttribute("aria-expanded", String(!chatCollapsed));
    if (chatBody) {
      chatBody.hidden = chatCollapsed;
    }
    if (!chatCollapsed) {
      unreadChat = 0;
    }
    if (chatUnread) {
      chatUnread.hidden = unreadChat === 0;
      chatUnread.textContent = unreadChat > 9 ? "9+" : String(unreadChat);
    }
  }

  function appendChatMessage(message) {
    if (!chatMessages) {
      return;
    }
    const row = document.createElement("div");
    row.className = `chat-message${message.playerId === state.you?.playerId ? " you" : ""}`;

    const meta = document.createElement("div");
    meta.className = "chat-meta";

    const name = document.createElement("span");
    name.className = "chat-name";
    name.style.color = state.peers.get(message.playerId)?.color || message.color || "black";
    name.textContent = typeof message.name === "string" && message.name ? message.name : `Player ${message.playerId + 1}`;

    const time = document.createElement("time");
    time.className = "chat-time";
    time.dateTime = Number.isFinite(message.ts) ? new Date(message.ts).toISOString() : "";
    time.textContent = formatChatTime(message.ts);

    const text = document.createElement("div");
    text.className = "chat-text";
    text.textContent = typeof message.text === "string" ? message.text : "";

    meta.append(name, time);
    row.append(meta, text);
    chatMessages.append(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    if (chatCollapsed) {
      unreadChat += 1;
      syncChatCollapsed();
    }
  }

  syncChatCollapsed();

  const settingsClose = settingsBackdrop.querySelector("[data-settings-close]");
  const resultClose = resultBackdrop.querySelector("[data-result-close]");
  const resultTitle = resultBackdrop.querySelector("[data-result-title]");
  const resultTime = resultBackdrop.querySelector("[data-result-time]");
  const resultRank = resultBackdrop.querySelector("[data-result-rank]");
  const leaderboardClose = leaderboardBackdrop.querySelector("[data-leaderboard-close]");
  const leaderboardTabs = leaderboardBackdrop.querySelector("[data-leaderboard-tabs]");
  const leaderboardModeTabs = leaderboardBackdrop.querySelector("[data-leaderboard-mode-tabs]");
  const leaderboardBody = leaderboardBackdrop.querySelector("[data-leaderboard-body]");
  const mineRange = settingsBackdrop.querySelector('[data-role="mine-range"]');
  const applyButton = settingsBackdrop.querySelector("[data-apply-reconfig]");
  const confirmRow = settingsBackdrop.querySelector('[data-role="confirm-reconfig"]');
  const widthInput = settingsBackdrop.querySelector('[name="settings-w"]');
  const heightInput = settingsBackdrop.querySelector('[name="settings-h"]');
  const minesInput = settingsBackdrop.querySelector('[name="settings-m"]');
  const noGuessInput = settingsBackdrop.querySelector('[name="settings-no-guess"]');
  const noGuessNote = settingsBackdrop.querySelector("[data-settings-noguess-note]");
  const renameForm = settingsBackdrop.querySelector("[data-rename-form]");
  const displayNameInput = settingsBackdrop.querySelector('[name="displayName"]');
  const renameError = settingsBackdrop.querySelector("[data-rename-error]");
  const renameStatus = settingsBackdrop.querySelector("[data-rename-status]");
  let pendingConfig = null;
  let activeLeaderboardPreset = presetForConfig(state) === "custom" ? "expert" : presetForConfig(state);
  let activeLeaderboardMode = NO_GUESS_ENABLED && state.noGuess === true ? "noguess" : "standard";
  let leaderboardBoards = null;
  let destroyed = false;

  function leaderboardEnabled() {
    return handlers.online === true || typeof handlers.onWin === "function";
  }

  function setRadio(name, value) {
    const input = settingsBackdrop.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) {
      input.checked = true;
    }
  }

  function setCheckbox(name, value) {
    const input = settingsBackdrop.querySelector(`input[name="${name}"]`);
    if (input) {
      input.checked = Boolean(value);
    }
  }

  function clearConfirm() {
    pendingConfig = null;
    confirmRow.hidden = true;
    applyButton.hidden = false;
  }

  function setGameInputs(config) {
    widthInput.value = String(config.w);
    heightInput.value = String(config.h);
    minesInput.value = String(config.mineCount);
  }

  function updateGameValidation() {
    const w = inputInteger(widthInput);
    const h = inputInteger(heightInput);
    const mineCount = inputInteger(minesInput);
    const dimensionsValid = w >= 5 && w <= 60 && h >= 5 && h <= 60;
    const maxMines = dimensionsValid ? w * h - 9 : 0;
    const valid = dimensionsValid && mineCount >= 1 && mineCount <= maxMines;

    mineRange.textContent = dimensionsValid ? `Valid mines: 1-${maxMines}` : "Width and height must be 5-60";
    minesInput.max = dimensionsValid ? String(maxMines) : "";
    const config = valid ? { w, h, mineCount } : null;
    const noGuessAvailable = Boolean(config && NO_GUESS_ENABLED && isNoGuessConfig(config));
    if (noGuessInput) {
      noGuessInput.disabled = !noGuessAvailable;
      noGuessInput.closest(".game-mode-toggle")?.classList.toggle("disabled", !noGuessAvailable);
      if (!noGuessAvailable) {
        noGuessInput.checked = false;
      }
    }
    if (noGuessNote) {
      noGuessNote.hidden = noGuessAvailable;
    }
    applyButton.disabled = !valid;
    return valid ? { ...config, noGuess: noGuessAvailable && noGuessInput?.checked === true } : null;
  }

  function syncSettingsForm() {
    setRadio("cellSize", prefs.cellSize);
    setRadio("theme", prefs.theme);
    setCheckbox("autoChord", prefs.autoChord);
    setCheckbox("autoFlag", prefs.autoFlag);
    setRadio("preset", presetForConfig(state));
    setGameInputs(state);
    if (noGuessInput) {
      noGuessInput.checked = state.noGuess === true && isNoGuessConfig(state);
    }
    if (displayNameInput) {
      displayNameInput.value = state.you?.name || "";
    }
    if (renameError) {
      renameError.hidden = true;
    }
    if (renameStatus) {
      renameStatus.hidden = true;
    }
    clearConfirm();
    updateGameValidation();
  }

  function openSettings() {
    syncSettingsForm();
    settingsBackdrop.hidden = false;
    settingsClose.focus();
  }

  function closeSettings() {
    settingsBackdrop.hidden = true;
    clearConfirm();
  }

  function resultMessage() {
    if (state.status !== STATUS.WON) {
      return "";
    }
    const outcome = state.winOutcome;
    if (outcome?.t === "WIN_RECORDED") {
      if (outcome.ranked && outcome.rank) {
        return `${formatRank(outcome.rank)} on ${presetLabel(presetForConfig(state))} ${modeLabel(state.noGuess)}!`;
      }
      if (outcome.reason === "outside_personal_best") {
        return `Not ranked — outside your personal top ${outcome.cap || 6} for this board.`;
      }
      return "Not ranked — outside the top 50.";
    }
    if (outcome?.t === "WIN_INELIGIBLE") {
      if (outcome.reason === "assist") {
        return "Not ranked: assists were enabled on this board.";
      }
      if (outcome.reason === "unranked") {
        return "UNRANKED: this game does not record leaderboard wins.";
      }
      return "Not ranked: custom board.";
    }
    if (state.leaderboardPending) {
      return "Checking leaderboard...";
    }
    return leaderboardEnabled() ? "Leaderboard result unavailable." : "UNRANKED: this game does not record leaderboard wins.";
  }

  function renderResult() {
    if (state.status !== STATUS.WON) {
      return;
    }
    const timeMs = Math.max(0, (state.endedAt || Date.now()) - (state.startedAt || state.endedAt || Date.now()));
    resultTitle.textContent = "Cleared";
    resultTime.textContent = `Time ${formatPreciseMs(timeMs)} seconds`;
    resultRank.textContent = resultMessage();
  }

  function showResult() {
    renderResult();
    resultBackdrop.hidden = false;
    resultClose.focus();
  }

  function closeResult() {
    resultBackdrop.hidden = true;
  }

  function renderLeaderboardLoading(text) {
    leaderboardBody.replaceChildren();
    const message = document.createElement("p");
    message.className = "leaderboard-empty";
    message.textContent = text;
    leaderboardBody.append(message);
  }

  function renderLeaderboardTabs() {
    leaderboardTabs.replaceChildren();
    for (const [key, label] of LEADERBOARD_PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.preset = key;
      button.textContent = label;
      button.className = key === activeLeaderboardPreset ? "active" : "";
      leaderboardTabs.append(button);
    }
    leaderboardModeTabs.replaceChildren();
    if (!isNoGuessPreset(activeLeaderboardPreset) && activeLeaderboardMode === "noguess") {
      activeLeaderboardMode = "standard";
    }
    for (const [key, label] of LEADERBOARD_MODES) {
      if (key === "noguess" && !isNoGuessPreset(activeLeaderboardPreset)) {
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.mode = key;
      button.textContent = label;
      button.className = key === activeLeaderboardMode ? "active" : "";
      leaderboardModeTabs.append(button);
    }
  }

  function renderLeaderboardRows() {
    renderLeaderboardTabs();
    leaderboardBody.replaceChildren();
    const board = leaderboardBoards?.[activeLeaderboardPreset];
    if (activeLeaderboardMode === "noguess" && !isNoGuessPreset(activeLeaderboardPreset)) {
      const empty = document.createElement("p");
      empty.className = "leaderboard-empty";
      empty.textContent = "No-guess is expert-only.";
      leaderboardBody.append(empty);
      return;
    }
    const entries = Array.isArray(board) ? board : board?.[activeLeaderboardMode] || [];
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "leaderboard-empty";
      empty.textContent = "No ranked wins yet.";
      leaderboardBody.append(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "leaderboard-table";
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["#", "Time", "Players", "Date"]) {
      const th = document.createElement("th");
      th.textContent = label;
      header.append(th);
    }
    thead.append(header);
    table.append(thead);

    const tbody = document.createElement("tbody");
    entries.forEach((entry, index) => {
      const row = document.createElement("tr");
      const contributorNames = Array.isArray(entry.contributors)
        ? entry.contributors.map((contributor) => contributor?.name).filter((name) => typeof name === "string" && name)
        : [];
      const legacyPlayerNames = Array.isArray(entry.players)
        ? entry.players.filter((name) => typeof name === "string" && name)
        : [];
      const cells = [
        String(index + 1),
        formatPreciseMs(entry.timeMs),
        (contributorNames.length > 0 ? contributorNames : legacyPlayerNames).join(", ") || "Unknown",
        entry.finishedAt ? new Date(entry.finishedAt).toLocaleDateString() : ""
      ];
      for (const value of cells) {
        const td = document.createElement("td");
        td.textContent = value;
        row.append(td);
      }
      tbody.append(row);
    });
    table.append(tbody);
    leaderboardBody.append(table);
  }

  async function openLeaderboard() {
    activeLeaderboardPreset = presetForConfig(state) === "custom" ? activeLeaderboardPreset : presetForConfig(state);
    activeLeaderboardMode = NO_GUESS_ENABLED && state.noGuess === true ? "noguess" : activeLeaderboardMode;
    leaderboardBackdrop.hidden = false;
    leaderboardClose.focus();
    renderLeaderboardTabs();
    renderLeaderboardLoading("Loading...");
    try {
      leaderboardBoards = await handlers.onLeaderboardOpen?.();
      renderLeaderboardRows();
    } catch {
      renderLeaderboardLoading("Unable to load leaderboard.");
    }
  }

  function closeLeaderboard() {
    leaderboardBackdrop.hidden = true;
  }

  function submitReconfig(config) {
    closeSettings();
    handlers.onReconfig?.(config);
  }

  function requestReconfig() {
    const config = updateGameValidation();
    if (!config) {
      return;
    }
    if (state.status === STATUS.PLAYING) {
      pendingConfig = config;
      confirmRow.hidden = false;
      applyButton.hidden = true;
      return;
    }
    submitReconfig(config);
  }

  settingsBackdrop.addEventListener("change", (event) => {
    const target = event.target;
    if (!target?.matches?.("input")) {
      return;
    }
    if (target.name === "cellSize") {
      prefs = { ...prefs, cellSize: target.value };
      handlers.onPrefsChange?.({ cellSize: target.value });
    } else if (target.name === "theme") {
      prefs = { ...prefs, theme: target.value };
      handlers.onPrefsChange?.({ theme: target.value });
    } else if (target.name === "autoChord" || target.name === "autoFlag") {
      prefs = { ...prefs, [target.name]: target.checked };
      handlers.onPrefsChange?.({ [target.name]: target.checked });
    } else if (target.name === "preset") {
      if (target.value !== "custom") {
        setGameInputs(PRESETS[target.value]);
      }
      clearConfirm();
      updateGameValidation();
    } else if (target.name === "settings-no-guess") {
      clearConfirm();
      updateGameValidation();
    }
  });

  settingsBackdrop.addEventListener("input", (event) => {
    if (event.target === displayNameInput) {
      if (renameError) {
        renameError.hidden = true;
      }
      if (renameStatus) {
        renameStatus.hidden = true;
      }
      return;
    }
    if (!event.target?.matches?.("[data-config-input]")) {
      return;
    }
    setRadio("preset", "custom");
    clearConfirm();
    updateGameValidation();
  });

  settingsBackdrop.addEventListener("click", (event) => {
    if (event.target === settingsBackdrop || event.target.closest("[data-settings-close]")) {
      closeSettings();
    } else if (event.target.closest("[data-apply-reconfig]")) {
      requestReconfig();
    } else if (event.target.closest("[data-confirm-reconfig]")) {
      if (pendingConfig) {
        submitReconfig(pendingConfig);
      }
    } else if (event.target.closest("[data-cancel-reconfig]")) {
      clearConfirm();
      updateGameValidation();
    }
  });

  settingsBackdrop.addEventListener("submit", (event) => {
    if (event.target !== renameForm) {
      return;
    }
    event.preventDefault();
    const name = cleanName(displayNameInput?.value);
    if (!isValidName(name)) {
      if (renameError) {
        renameError.textContent = "Enter 1-20 characters.";
        renameError.hidden = false;
      }
      if (renameStatus) {
        renameStatus.hidden = true;
      }
      displayNameInput?.focus();
      return;
    }
    if (displayNameInput) {
      displayNameInput.value = name;
    }
    handlers.onRename?.(name);
  });

  chatToggle?.addEventListener("click", () => {
    chatCollapsed = !chatCollapsed;
    syncChatCollapsed();
    if (!chatCollapsed) {
      chatInput?.focus();
    }
  });

  chatForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = chatInput?.value || "";
    if (!text.trim()) {
      chatInput?.focus();
      return;
    }
    handlers.onChatSend?.(text);
    if (chatInput) {
      chatInput.value = "";
      chatInput.focus();
    }
    if (chatNotice) {
      chatNotice.hidden = true;
    }
  });

  chatInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    chatForm?.requestSubmit();
  });

  resultBackdrop.addEventListener("click", (event) => {
    if (event.target === resultBackdrop || event.target.closest("[data-result-close]")) {
      closeResult();
    }
  });

  leaderboardBackdrop.addEventListener("click", (event) => {
    if (event.target === leaderboardBackdrop || event.target.closest("[data-leaderboard-close]")) {
      closeLeaderboard();
      return;
    }
    const tab = event.target.closest("[data-preset]");
    if (tab) {
      activeLeaderboardPreset = tab.dataset.preset;
      renderLeaderboardRows();
      return;
    }
    const modeTab = event.target.closest("[data-mode]");
    if (modeTab) {
      activeLeaderboardMode = modeTab.dataset.mode;
      renderLeaderboardRows();
    }
  });

  function onWindowKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    if (!settingsBackdrop.hidden) {
      event.preventDefault();
      closeSettings();
    } else if (!leaderboardBackdrop.hidden) {
      event.preventDefault();
      closeLeaderboard();
    } else if (!resultBackdrop.hidden) {
      event.preventDefault();
      closeResult();
    }
  }

  window.addEventListener("keydown", onWindowKeyDown);
  updateGameValidation();

  function flagOwnerClass(idx) {
    const flag = state.flags[idx];
    if (flag === AUTO_FLAG || presence.peerCount() < 2) {
      return null;
    }
    const owner = flag - 1;
    return owner < 0 ? null : `peer-flag-owner-${owner % 8}`;
  }

  function updateCell(idx) {
    const cell = cells[idx];
    const isRevealed = state.revealed[idx] === 1;
    const isMine = state.mines.has(idx);
    const isWrong = state.wrongFlags.has(idx);
    const isLostMine = state.status === STATUS.LOST && isMine;
    const isWonMine = state.status === STATUS.WON && isMine;
    const hasFlag = state.flags[idx] > 0;
    const isDetonated = state.status === STATUS.LOST && idx === state.lostAt;
    const isCorrectLostFlag = isLostMine && hasFlag && !isDetonated;
    const flagged = hasFlag || isWonMine || isCorrectLostFlag;
    const isPending = pending.has(idx);
    const count = state.counts[idx];

    cell.className = "cell";
    cell.innerHTML = "";
    delete cell.dataset.count;

    if (isDetonated) {
      cell.classList.add("revealed", "mine-cell", "detonated");
      cell.innerHTML = mineSvg();
    } else if (isWrong) {
      cell.classList.add("revealed", "wrong-flag");
      cell.innerHTML = wrongFlagSvg();
    } else if (isCorrectLostFlag) {
      cell.classList.add("unrevealed", "flagged", "correct-flag");
      const ownerClass = flagOwnerClass(idx);
      if (ownerClass) {
        cell.classList.add("peer-flag", ownerClass);
      }
      cell.innerHTML = correctFlagSvg();
    } else if (isLostMine) {
      cell.classList.add("revealed", "mine-cell");
      cell.innerHTML = mineSvg();
    } else if (flagged && !isRevealed) {
      cell.classList.add("unrevealed", "flagged");
      if (isWonMine) {
        cell.classList.add("correct-flag");
      }
      const ownerClass = flagOwnerClass(idx);
      if (ownerClass) {
        cell.classList.add("peer-flag", ownerClass);
      }
      cell.innerHTML = isWonMine ? correctFlagSvg() : flagSvg();
    } else if (isPending && !isRevealed) {
      cell.classList.add("pending");
    } else if (isRevealed) {
      cell.classList.add("revealed");
      cell.dataset.count = String(count);
      if (count > 0) {
        cell.textContent = String(count);
      }
    } else {
      cell.classList.add("unrevealed");
    }

    presence.refreshCell(idx);
  }

  function flushRender() {
    renderFrame = 0;
    const indices = [...dirtyCells];
    dirtyCells.clear();
    for (const idx of indices) {
      updateCell(idx);
    }
    if (renderChrome) {
      chrome.update(state, held);
      renderChrome = false;
    }
  }

  function updateCells(indices) {
    for (const idx of indices) {
      if (idx >= 0 && idx < cells.length) {
        dirtyCells.add(idx);
      }
    }
    renderChrome = true;
    if (!renderFrame) {
      renderFrame = requestAnimationFrame(flushRender);
    }
  }

  function updateAll() {
    if (renderFrame) {
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
    dirtyCells.clear();
    renderChrome = false;
    for (let idx = 0; idx < cells.length; idx += 1) {
      updateCell(idx);
    }
    chrome.update(state, held);
    presence.refreshAll();
  }

  function connectedPlayerCount() {
    return state.peers.size;
  }

  function isSoloMode() {
    return handlers.online === true && state.you && connectedPlayerCount() === 1 && state.peers.has(state.you.playerId);
  }

  function visibleEngineState() {
    return {
      seed: state.seed,
      w: state.w,
      h: state.h,
      mineCount: state.mineCount,
      noGuess: state.noGuess === true,
      status: state.status,
      board: null,
      revealed: new Uint8Array(state.revealed),
      flags: new Uint8Array(state.flags),
      flagCount: state.flagCount,
      revealedCount: state.revealed.reduce((count, value) => count + (value === 1 ? 1 : 0), 0),
      startedAt: state.startedAt || 0,
      endedAt: state.endedAt || 0,
      lostAt: state.lostAt ?? -1,
      assistTainted: false,
      contributors: []
    };
  }

  function recordOptimisticFrame(seq, events, beforeFlags, beforeFlagCount) {
    if (!Number.isSafeInteger(seq) || events.length === 0) {
      return;
    }
    optimisticFrames.set(seq, {
      events: normalizedEvents(events),
      beforeFlags,
      beforeFlagCount
    });
  }

  function rollbackOptimisticFrame(frame, changed) {
    state.flagCount = frame.beforeFlagCount;
    for (const [idx, value] of frame.beforeFlags) {
      state.flags[idx] = value;
      changed.add(idx);
    }
  }

  function applyFlagEvent(event, changed) {
    if (event.idx < 0 || event.idx >= state.flags.length) {
      return;
    }
    if (event.on) {
      if (!state.flags[event.idx]) {
        state.flagCount += 1;
      }
      state.flags[event.idx] = event.playerId + 1;
    } else if (state.flags[event.idx]) {
      state.flags[event.idx] = 0;
      state.flagCount -= 1;
    }
    changed.add(event.idx);
  }

  function releasePendingGroup(group) {
    clearTimeout(group.timeout);
    pendingGroups.delete(group);
    const released = [];
    for (const idx of group.indices) {
      let stillPending = false;
      for (const other of pendingGroups) {
        if (other.indices.has(idx)) {
          stillPending = true;
          break;
        }
      }
      if (!stillPending) {
        pending.delete(idx);
        cells[idx]?.classList.remove("pending");
        released.push(idx);
      }
    }
    return released;
  }

  function clearPendingGroup(group) {
    const released = releasePendingGroup(group);
    updateCells(released);
  }

  function clearPendingForChanged(changed) {
    const released = [];
    for (const group of [...pendingGroups]) {
      if ([...group.indices].some((idx) => changed.has(idx))) {
        released.push(...releasePendingGroup(group));
      }
    }
    return released;
  }

  function clearPendingForSeq(seq) {
    if (!Number.isSafeInteger(seq)) {
      return [];
    }

    const released = [];
    for (const group of [...pendingGroups]) {
      if (group.seq === seq) {
        released.push(...releasePendingGroup(group));
      }
    }
    return released;
  }

  function clearAllPending() {
    const released = [];
    for (const group of [...pendingGroups]) {
      released.push(...releasePendingGroup(group));
    }
    updateCells(released);
  }

  function setPending(indices, seq) {
    const unique = [...new Set(indices)].filter((idx) => idx >= 0 && idx < cells.length);
    if (unique.length === 0) {
      return;
    }

    const group = { seq, indices: new Set(unique), timeout: 0 };
    pendingGroups.add(group);
    for (const idx of unique) {
      pending.add(idx);
      cells[idx]?.classList.remove("pressed");
      cells[idx]?.classList.add("pending");
    }
    group.timeout = setTimeout(() => clearPendingGroup(group), PENDING_TIMEOUT_MS);
  }

  function applyEvents(message) {
    const frame = Array.isArray(message) ? { events: message } : message || { events: [] };
    const events = Array.isArray(frame.events) ? frame.events : [];
    const changed = new Set();
    let wonThisFrame = false;
    const optimistic = Number.isSafeInteger(frame.seq) ? optimisticFrames.get(frame.seq) : null;
    if (optimistic) {
      optimisticFrames.delete(frame.seq);
      if (optimistic.events === normalizedEvents(events)) {
        for (const idx of clearPendingForSeq(frame.seq)) {
          changed.add(idx);
        }
        if (changed.size > 0) {
          updateCells(changed);
        }
        return;
      }
      rollbackOptimisticFrame(optimistic, changed);
    }
    for (const idx of clearPendingForSeq(frame.seq)) {
      changed.add(idx);
    }
    for (const event of events) {
      if (event.t === "START") {
        state.status = STATUS.PLAYING;
        state.startedAt = event.startedAt;
      } else if (event.t === "OPEN") {
        for (const cell of event.cells) {
          state.revealed[cell.idx] = 1;
          state.counts[cell.idx] = cell.count;
          changed.add(cell.idx);
        }
      } else if (event.t === "FLAG") {
        applyFlagEvent(event, changed);
      } else if (event.t === "BOOM") {
        state.status = STATUS.LOST;
        state.endedAt = event.endedAt || Date.now();
        state.lostAt = event.idx;
        state.mines = new Set(event.mines);
        state.wrongFlags = new Set(event.wrongFlags || []);
        for (const idx of event.mines) changed.add(idx);
        for (const idx of event.wrongFlags || []) changed.add(idx);
        for (let idx = 0; idx < state.flags.length; idx += 1) {
          if (state.flags[idx]) changed.add(idx);
        }
      } else if (event.t === "WIN") {
        state.status = STATUS.WON;
        state.endedAt = event.endedAt;
        state.mines = new Set(event.mines);
        state.flagCount = state.mineCount;
        state.leaderboardPending = leaderboardEnabled();
        state.winOutcome = null;
        wonThisFrame = true;
        for (const idx of event.mines) {
          state.flags[idx] ||= AUTO_FLAG;
          changed.add(idx);
        }
      }
    }
    for (const idx of clearPendingForChanged(changed)) {
      changed.add(idx);
    }
    updateCells(changed);
    if (wonThisFrame) {
      showResult();
      if (typeof handlers.onWin === "function") {
        const submittedState = { ...state };
        void handlers
          .onWin(submittedState)
          .then((outcome) => {
            if (destroyed) {
              return;
            }
            state.winOutcome = outcome;
            state.leaderboardPending = false;
            renderResult();
          })
          .catch(() => {
            if (destroyed) {
              return;
            }
            state.leaderboardPending = false;
            renderResult();
          });
      }
    }
  }

  function applyOptimisticAction(action) {
    if (!isSoloMode() || !Number.isSafeInteger(action?.seq) || action?.type !== "FLAG") {
      return;
    }

    const playerId = state.you?.playerId;
    if (!Number.isInteger(playerId)) {
      return;
    }

    const result = applyAction(visibleEngineState(), {
      type: action.type,
      idx: action.idx,
      assist: action.assist,
      playerId,
      playerName: state.you?.name || "",
      now: Date.now()
    });
    const events = result.events.filter((event) => event.t === "FLAG");
    if (events.length === 0) {
      return;
    }

    const beforeFlags = new Map(events.map((event) => [event.idx, state.flags[event.idx] || 0]));
    const beforeFlagCount = state.flagCount;
    const changed = new Set();
    for (const event of events) {
      applyFlagEvent(event, changed);
    }
    recordOptimisticFrame(action.seq, events, beforeFlags, beforeFlagCount);
    updateCells(changed);
  }

  function showNotice(text) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = text;
    toastStack.append(toast);
    const timeout = setTimeout(() => {
      toast.remove();
      toastTimers.delete(timeout);
    }, 3500);
    toastTimers.add(timeout);
  }

  updateAll();
  timer = setInterval(() => chrome.update(state, held), 500);

  return {
    board,
    cells,
    getState: () => state,
    applyEvents,
    applyOptimisticAction,
    isSoloMode,
    updateCell,
    updateAll,
    setHeld(value) {
      held = value;
      chrome.update(state, generating || held);
    },
    setPressed(indices) {
      for (const cell of cells) {
        cell.classList.remove("pressed");
      }
      for (const idx of indices) {
        cells[idx]?.classList.add("pressed");
      }
    },
    clearPressed() {
      for (const cell of cells) {
        cell.classList.remove("pressed");
      }
    },
    setPending,
    setGenerating(value) {
      generating = value === true;
      chrome.update(state, generating || held);
    },
    getAssist() {
      return { autoChord: prefs.autoChord === true, autoFlag: prefs.autoFlag === true };
    },
    setPeers(peers, you) {
      state.you = you || state.you;
      for (const peer of peers) {
        state.peers.set(peer.playerId, peer);
      }
      presence.setPeers(peers, state.you);
      updateAll();
    },
    upsertPeer(peer) {
      state.peers.set(peer.playerId, peer);
      if (state.you?.playerId === peer.playerId) {
        state.you = peer;
      }
      presence.upsertPeer(peer, state.you?.playerId);
      updateAll();
    },
    renamePeer(playerId, name) {
      const existing = state.peers.get(playerId);
      if (!existing) {
        return;
      }
      const peer = { ...existing, name };
      state.peers.set(playerId, peer);
      if (state.you?.playerId === playerId) {
        state.you = peer;
        if (displayNameInput && !settingsBackdrop.hidden) {
          displayNameInput.value = name;
        }
      }
      presence.upsertPeer(peer, state.you?.playerId);
      updateAll();
    },
    removePeer(playerId) {
      state.peers.delete(playerId);
      presence.removePeer(playerId, state.you?.playerId);
      updateAll();
    },
    setCursor(playerId, idx) {
      presence.setCursor(playerId, idx);
    },
    setBanner(show) {
      banner.hidden = !show;
      if (show) {
        clearAllPending();
      }
    },
    setWinOutcome(outcome) {
      state.winOutcome = outcome;
      state.leaderboardPending = false;
      if (state.status === STATUS.WON) {
        renderResult();
        if (resultBackdrop.hidden) {
          showResult();
        }
      }
    },
    showNotice,
    addChatMessage(message) {
      if (!chatEnabled) {
        return;
      }
      appendChatMessage(message);
    },
    showChatNotice(message) {
      if (!chatNotice) {
        showNotice(message);
        return;
      }
      chatNotice.textContent = message;
      chatNotice.hidden = false;
    },
    setRenameError(message) {
      if (renameError) {
        renameError.textContent = message || "Unable to change username.";
        renameError.hidden = false;
      }
      if (renameStatus) {
        renameStatus.hidden = true;
      }
      displayNameInput?.focus();
    },
    setRenameStatus(message) {
      if (!renameStatus) {
        return;
      }
      renameStatus.textContent = message || "";
      renameStatus.hidden = !message;
      if (renameError) {
        renameError.hidden = true;
      }
    },
    setPrefs(nextPrefs) {
      prefs = { ...prefs, ...nextPrefs };
      if (!settingsBackdrop.hidden) {
        syncSettingsForm();
      }
    },
    destroy() {
      destroyed = true;
      window.removeEventListener("keydown", onWindowKeyDown);
      for (const timeout of toastTimers) {
        clearTimeout(timeout);
      }
      for (const group of [...pendingGroups]) {
        releasePendingGroup(group);
      }
      if (renderFrame) {
        cancelAnimationFrame(renderFrame);
      }
      clearInterval(timer);
    }
  };
}
