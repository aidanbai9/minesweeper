import { generateBoard, neighbors, noGuessAttemptSeed, solves } from "../engine/index.js";

let nextActionSeq = 1;
const NO_GUESS_OPTS = Object.freeze({ maxDepth: 4, maxWidth: 6, maxAttempts: 8 });

function cellIdxFromEvent(event) {
  const cell = event.target.closest?.(".cell");
  return cell ? Number(cell.dataset.idx) : -1;
}

function canPressChord(state, idx) {
  return idx >= 0 && state.revealed[idx] && state.counts[idx] > 0;
}

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.("button, input, select, textarea, [contenteditable='true']"));
}

function chordPressedCells(state, idx) {
  if (!canPressChord(state, idx)) {
    return [];
  }
  return neighbors(idx, state.w, state.h).filter((n) => !state.revealed[n] && !state.flags[n]);
}

function actionForCell(state, idx, button) {
  if (idx < 0) {
    return null;
  }

  if (!state.revealed[idx]) {
    if (button === "space") {
      return { type: "FLAG", idx, immediate: true };
    }
    if (button === "left" && !state.flags[idx]) {
      return { type: "REVEAL", idx, indices: [idx] };
    }
    return null;
  }

  if (state.counts[idx] > 0) {
    return { type: "CHORD", idx, indices: chordPressedCells(state, idx) };
  }

  return null;
}

export function setupInput(board, api, transport) {
  let held = null;
  let hovered = -1;
  let lastCursorAt = 0;
  let spaceHeld = false;

  async function findNoGuessSeed(state, idx) {
    if (state.noGuessVerified && state.seed && state.noGuessSafeIdx === idx) {
      return { seed: state.seed, attempt: 0, layout: null };
    }
    const baseSeed = state.seed || crypto.randomUUID();
    const config = { w: state.w, h: state.h, mineCount: state.mineCount };
    const maxAttempts = state.w * state.h > 1000 ? 1 : NO_GUESS_OPTS.maxAttempts;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const seed = noGuessAttemptSeed(baseSeed, idx, attempt);
      const layout = generateBoard(seed, state.w, state.h, state.mineCount, idx);
      if (solves(layout, idx, config, NO_GUESS_OPTS)) {
        return { seed, attempt, layout };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { failed: true, reason: "no_solvable_board" };
  }

  async function sendAction(action, pendingIndices = null) {
    const state = api.getState();
    let payload = action;
    if (action.type === "REVEAL" && state.noGuess === true && state.status === 0) {
      api.setGenerating(true);
      const result = await findNoGuessSeed(state, action.idx);
      api.setGenerating(false);
      if (result.failed) {
        api.showNotice("No no-guess board found quickly for this click. Start a standard game or use a smaller board.");
        return null;
      }
      payload = { ...action, noGuessSeed: result.seed };
    }
    const seq = nextActionSeq;
    nextActionSeq += 1;
    if (pendingIndices) {
      api.setPending(pendingIndices, seq);
    }
    transport.send({ ...payload, seq, assist: api.getAssist() });
    return seq;
  }

  function press(indices) {
    api.setPressed(indices);
    api.setHeld(true);
  }

  function clear(clearPressed = true) {
    held = null;
    if (clearPressed) {
      api.clearPressed();
    }
    api.setHeld(false);
  }

  function sendCursor(idx, force = false) {
    const now = performance.now();
    if (force || now - lastCursorAt >= 100) {
      lastCursorAt = now;
      transport.send({ type: "CURSOR", idx });
    }
  }

  function onMouseMove(event) {
    const idx = cellIdxFromEvent(event);
    if (idx !== hovered) {
      hovered = idx;
      sendCursor(idx);
    }
  }

  function onMouseLeave() {
    if (hovered !== -1) {
      hovered = -1;
      sendCursor(-1, true);
    }
    if (!held?.keyboard) {
      clear();
    }
  }

  function onMouseDown(event) {
    if (spaceHeld) {
      return;
    }
    const idx = cellIdxFromEvent(event);
    if (idx < 0) {
      return;
    }
    const state = api.getState();
    if (event.button === 0) {
      if (event.shiftKey) {
        event.preventDefault();
        const action = actionForCell(state, idx, "space");
        if (!action) {
          return;
        }
        if (action.immediate) {
          void sendAction({ type: action.type, idx: action.idx });
          return;
        }
        held = action;
        press(action.indices || []);
        return;
      }

      const action = actionForCell(state, idx, "left");
      if (!action) {
        return;
      }
      held = action;
      press(action.indices || []);
    } else if (event.button === 1) {
      event.preventDefault();
      const indices = chordPressedCells(state, idx);
      held = { type: "CHORD", idx, indices };
      press(indices);
    } else if (event.button === 2) {
      event.preventDefault();
      void sendAction({ type: "FLAG", idx });
    }
  }

  function onMouseUp(event) {
    if (!held || held.keyboard) {
      return;
    }
    const idx = cellIdxFromEvent(event);
    if (idx === held.idx) {
      void sendAction({ type: held.type, idx }, held.indices || []);
      clear(false);
      return;
    }
    clear();
  }

  function onKeyDown(event) {
    if (event.code !== "Space") {
      return;
    }
    if (isInteractiveTarget(event.target)) {
      return;
    }
    event.preventDefault();
    if (event.repeat === true || spaceHeld || held) {
      return;
    }
    spaceHeld = true;

    const idx = hovered;
    if (idx < 0) {
      return;
    }
    const state = api.getState();
    const action = actionForCell(state, idx, "space");
    if (!action) {
      return;
    }
    if (action.immediate) {
      void sendAction({ type: action.type, idx: action.idx });
      return;
    }
    held = { ...action, keyboard: true };
    const indices = action.indices || [];
    void sendAction({ type: action.type, idx: action.idx }, indices);
    press(indices);
  }

  function onKeyUp(event) {
    if (event.code !== "Space" || !spaceHeld) {
      return;
    }
    event.preventDefault();
    spaceHeld = false;
    if (held?.keyboard) {
      clear(false);
    } else {
      clear();
    }
  }

  board.addEventListener("mousemove", onMouseMove);
  board.addEventListener("mousedown", onMouseDown);
  board.addEventListener("mouseup", onMouseUp);
  board.addEventListener("mouseleave", onMouseLeave);
  board.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return () => {
    board.removeEventListener("mousemove", onMouseMove);
    board.removeEventListener("mousedown", onMouseDown);
    board.removeEventListener("mouseup", onMouseUp);
    board.removeEventListener("mouseleave", onMouseLeave);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
