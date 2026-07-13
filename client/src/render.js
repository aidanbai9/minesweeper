import { createChrome } from "./chrome.js";
import { CLASSIC_FLAG_COLOR, createPresence } from "./presence.js";
import { AUTO_FLAG, PRESETS } from "../engine/index.js";

const STATUS = { PENDING: 0, PLAYING: 1, WON: 2, LOST: 3 };
const NUMBER_CLASSES = ["", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
const CELL_SIZE_OPTIONS = ["100", "150", "200"];
const PENDING_TIMEOUT_MS = 1500;
const PRESET_OPTIONS = [
  ["beginner", "Beginner"],
  ["intermediate", "Intermediate"],
  ["expert", "Expert"],
  ["custom", "Custom"]
];

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

function settingsHtml(state, prefs) {
  const preset = presetForConfig(state);
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
          </fieldset>
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

function inputInteger(input) {
  if (!input.value.trim()) {
    return NaN;
  }
  const value = Number(input.value);
  return Number.isInteger(value) ? value : NaN;
}

function flagSvg(color = CLASSIC_FLAG_COLOR) {
  return `
    <svg class="flag-svg" viewBox="0 0 16 16" aria-hidden="true" style="--flag-color:${color}">
      <path d="M5 3h1v9H5z" fill="#000"/>
      <path d="M4 12h7v2H3v-1z" fill="#000"/>
      <path class="flag-cloth" d="M6 3l7 3-7 3z"/>
    </svg>
  `;
}

function mineSvg(extra = "") {
  return `
    <svg class="mine-svg ${extra}" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13" stroke="#000" stroke-width="1.5"/>
      <circle cx="8" cy="8" r="4.5" fill="#000"/>
      <circle cx="6.5" cy="6.5" r="1" fill="#fff"/>
    </svg>
  `;
}

function wrongFlagSvg() {
  return `
    ${mineSvg()}
    <svg class="wrong-x" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 2l12 12M14 2L2 14" stroke="#f00" stroke-width="2"/>
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
    w,
    h,
    mineCount,
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
    peers
  };
}

export function mountGame(root, initialState, handlers) {
  let state = initialState;
  let prefs = { cellSize: "100", autoChord: false, autoFlag: false, ...(handlers.prefs || {}) };
  let held = false;
  let timer = 0;
  let renderFrame = 0;
  let renderChrome = false;
  const toastTimers = new Set();
  const pending = new Set();
  const pendingGroups = new Set();
  const dirtyCells = new Set();

  root.innerHTML = `
    <div class="reconnect-banner" hidden>reconnecting...</div>
    <div class="toast-stack" aria-live="polite" aria-atomic="true"></div>
    <main class="shell">
      <section class="mines-panel">
        <div class="top chrome"></div>
        <div class="board-frame">
          <div class="board" role="grid"></div>
        </div>
        <div class="peer-strip"></div>
      </section>
    </main>
    ${settingsHtml(state, prefs)}
  `;

  const banner = root.querySelector(".reconnect-banner");
  const toastStack = root.querySelector(".toast-stack");
  const settingsBackdrop = root.querySelector(".settings-backdrop");
  const chrome = createChrome(root.querySelector(".chrome"), { onReset: handlers.onReset, onSettings: openSettings });
  const board = root.querySelector(".board");
  const peerStrip = root.querySelector(".peer-strip");
  board.style.gridTemplateColumns = `repeat(${state.w}, var(--cell))`;
  board.style.gridTemplateRows = `repeat(${state.h}, var(--cell))`;

  const cells = Array.from({ length: state.w * state.h }, (_, idx) => {
    const cell = document.createElement("div");
    cell.className = "cell unrevealed";
    cell.dataset.idx = String(idx);
    cell.setAttribute("role", "gridcell");
    board.append(cell);
    return cell;
  });

  const presence = createPresence(cells, peerStrip);
  presence.setPeers([...state.peers.values()].filter((peer) => peer.playerId !== state.you?.playerId), state.you);

  const settingsClose = settingsBackdrop.querySelector("[data-settings-close]");
  const mineRange = settingsBackdrop.querySelector('[data-role="mine-range"]');
  const applyButton = settingsBackdrop.querySelector("[data-apply-reconfig]");
  const confirmRow = settingsBackdrop.querySelector('[data-role="confirm-reconfig"]');
  const widthInput = settingsBackdrop.querySelector('[name="settings-w"]');
  const heightInput = settingsBackdrop.querySelector('[name="settings-h"]');
  const minesInput = settingsBackdrop.querySelector('[name="settings-m"]');
  let pendingConfig = null;

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
    applyButton.disabled = !valid;
    return valid ? { w, h, mineCount } : null;
  }

  function syncSettingsForm() {
    setRadio("cellSize", prefs.cellSize);
    setCheckbox("autoChord", prefs.autoChord);
    setCheckbox("autoFlag", prefs.autoFlag);
    setRadio("preset", presetForConfig(state));
    setGameInputs(state);
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
    } else if (target.name === "autoChord" || target.name === "autoFlag") {
      prefs = { ...prefs, [target.name]: target.checked };
      handlers.onPrefsChange?.({ [target.name]: target.checked });
    } else if (target.name === "preset") {
      if (target.value !== "custom") {
        setGameInputs(PRESETS[target.value]);
      }
      clearConfirm();
      updateGameValidation();
    }
  });

  settingsBackdrop.addEventListener("input", (event) => {
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

  function onWindowKeyDown(event) {
    if (event.key === "Escape" && !settingsBackdrop.hidden) {
      event.preventDefault();
      closeSettings();
    }
  }

  window.addEventListener("keydown", onWindowKeyDown);
  updateGameValidation();

  function flagColor(idx) {
    const flag = state.flags[idx];
    if (flag === AUTO_FLAG || presence.peerCount() < 2) {
      return CLASSIC_FLAG_COLOR;
    }
    const owner = flag - 1;
    return owner < 0 ? CLASSIC_FLAG_COLOR : presence.colorFor(owner);
  }

  function updateCell(idx) {
    const cell = cells[idx];
    const isRevealed = state.revealed[idx] === 1;
    const isMine = state.mines.has(idx);
    const isWrong = state.wrongFlags.has(idx);
    const isLostMine = state.status === STATUS.LOST && isMine;
    const isWonMine = state.status === STATUS.WON && isMine;
    const flagged = state.flags[idx] > 0 || isWonMine;
    const isPending = pending.has(idx);
    const count = state.counts[idx];

    cell.className = "cell";
    cell.innerHTML = "";

    if (isWrong) {
      cell.classList.add("revealed", "wrong-flag");
      cell.innerHTML = wrongFlagSvg();
    } else if (isLostMine) {
      cell.classList.add("revealed", "mine-cell");
      if (idx === state.lostAt) {
        cell.classList.add("detonated");
      }
      cell.innerHTML = mineSvg();
    } else if (flagged && !isRevealed) {
      cell.classList.add("unrevealed", "flagged");
      cell.innerHTML = flagSvg(flagColor(idx));
    } else if (isPending && !isRevealed) {
      cell.classList.add("pending");
    } else if (isRevealed) {
      cell.classList.add("revealed");
      if (count > 0) {
        cell.classList.add(NUMBER_CLASSES[count]);
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

  function clearAllPending() {
    const released = [];
    for (const group of [...pendingGroups]) {
      released.push(...releasePendingGroup(group));
    }
    updateCells(released);
  }

  function setPending(indices) {
    const unique = [...new Set(indices)].filter((idx) => idx >= 0 && idx < cells.length);
    if (unique.length === 0) {
      return;
    }

    const group = { indices: new Set(unique), timeout: 0 };
    pendingGroups.add(group);
    for (const idx of unique) {
      pending.add(idx);
      cells[idx]?.classList.remove("pressed");
      cells[idx]?.classList.add("pending");
    }
    group.timeout = setTimeout(() => clearPendingGroup(group), PENDING_TIMEOUT_MS);
  }

  function applyEvents(events) {
    const changed = new Set();
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
        if (event.on) {
          state.flags[event.idx] = event.playerId + 1;
          state.flagCount += 1;
        } else if (state.flags[event.idx]) {
          state.flags[event.idx] = 0;
          state.flagCount -= 1;
        }
        changed.add(event.idx);
      } else if (event.t === "BOOM") {
        state.status = STATUS.LOST;
        state.endedAt = event.endedAt || Date.now();
        state.lostAt = event.idx;
        state.mines = new Set(event.mines);
        state.wrongFlags = new Set(event.wrongFlags || []);
        for (const idx of event.mines) changed.add(idx);
        for (const idx of event.wrongFlags || []) changed.add(idx);
      } else if (event.t === "WIN") {
        state.status = STATUS.WON;
        state.endedAt = event.endedAt;
        state.mines = new Set(event.mines);
        state.flagCount = state.mineCount;
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
    updateCell,
    updateAll,
    setHeld(value) {
      held = value;
      chrome.update(state, held);
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
    showNotice,
    setPrefs(nextPrefs) {
      prefs = { ...prefs, ...nextPrefs };
      if (!settingsBackdrop.hidden) {
        syncSettingsForm();
      }
    },
    destroy() {
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
