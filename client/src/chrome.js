const DIGIT_SEGMENTS = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "c", "d", "g"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "e", "d", "c", "g"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
  "-": ["g"]
};

function formatCounter(value) {
  const clamped = Math.max(-99, Math.min(999, value));
  if (clamped < 0) {
    return `-${String(Math.abs(clamped)).padStart(2, "0")}`;
  }
  return String(clamped).padStart(3, "0");
}

function digitHtml(char) {
  const on = new Set(DIGIT_SEGMENTS[char] || []);
  const glyph = char === "-" ? "neg" : char;
  return `<div class="led-digit" data-glyph="${glyph}" aria-hidden="true">${["a", "b", "c", "d", "e", "f", "g"]
    .map((seg) => `<span class="seg seg-${seg} ${on.has(seg) ? "on" : ""}"></span>`)
    .join("")}</div>`;
}

function renderLed(el, value) {
  el.innerHTML = formatCounter(value)
    .split("")
    .map((char) => digitHtml(char))
    .join("");
}

function elapsedSeconds(state) {
  if (!state.startedAt) {
    return 0;
  }
  const end = state.endedAt || Date.now();
  return Math.min(999, Math.max(0, Math.floor((end - state.startedAt) / 1000)));
}

export function createChrome(root, handlers = {}) {
  root.innerHTML = `
    <div class="counter led" data-role="mines" aria-label="remaining mines"></div>
    <button class="face" type="button" aria-label="reset">:)</button>
    <div class="counter led" data-role="time" aria-label="elapsed seconds"></div>
    <button class="leaderboard-button" type="button" aria-label="leaderboard">LB</button>
    <button class="settings-button" type="button" aria-label="settings">⚙</button>
  `;
  const mines = root.querySelector('[data-role="mines"]');
  const time = root.querySelector('[data-role="time"]');
  const face = root.querySelector(".face");
  const leaderboard = root.querySelector(".leaderboard-button");
  const settings = root.querySelector(".settings-button");
  if (handlers.onReset) {
    face.addEventListener("click", handlers.onReset);
  }
  if (handlers.onLeaderboard) {
    leaderboard.addEventListener("click", handlers.onLeaderboard);
  }
  if (handlers.onSettings) {
    settings.addEventListener("click", handlers.onSettings);
  }

  return {
    update(state, held = false) {
      renderLed(mines, state.mineCount - state.flagCount);
      renderLed(time, elapsedSeconds(state));
      if (state.status === 2) {
        face.textContent = "B-)";
      } else if (state.status === 3) {
        face.textContent = "X(";
      } else {
        face.textContent = held ? ":O" : ":)";
      }
    }
  };
}
