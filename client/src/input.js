import { neighbors } from "../engine/index.js";

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

export function setupInput(board, api, transport) {
  let held = null;
  let hovered = -1;
  let lastCursorAt = 0;
  let spaceHeld = false;

  function sendAction(action) {
    transport.send({ ...action, assist: api.getAssist() });
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

  function clearKeyboardHold() {
    if (held?.keyboard) {
      clear();
    }
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
      const indices = !state.revealed[idx] && !state.flags[idx] ? [idx] : [];
      held = { type: "REVEAL", idx, indices };
      if (!state.revealed[idx] && !state.flags[idx]) {
        press(indices);
      } else {
        api.setHeld(true);
      }
    } else if (event.button === 1) {
      event.preventDefault();
      const indices = chordPressedCells(state, idx);
      held = { type: "CHORD", idx, indices };
      press(indices);
    } else if (event.button === 2) {
      event.preventDefault();
      sendAction({ type: "FLAG", idx });
    }
  }

  function onMouseUp(event) {
    if (!held || held.keyboard) {
      return;
    }
    const idx = cellIdxFromEvent(event);
    if (idx === held.idx) {
      api.setPending(held.indices || []);
      sendAction({ type: held.type, idx });
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
    if (!state.revealed[idx]) {
      sendAction({ type: "FLAG", idx });
      return;
    }
    if (state.counts[idx] > 0) {
      const indices = chordPressedCells(state, idx);
      held = { type: "CHORD", idx, keyboard: true, indices };
      press(indices);
      api.setPending(indices);
      sendAction({ type: "CHORD", idx });
    }
  }

  function onKeyUp(event) {
    if (event.code !== "Space" || !spaceHeld) {
      return;
    }
    event.preventDefault();
    spaceHeld = false;
    clearKeyboardHold();
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
