import { generateBoard } from "./board.js";
import { TANK_COMPONENT_CAP, tankSolves } from "./tank-solver.js";

function normalizeAttempts(opts = {}) {
  return Math.max(1, Number.isInteger(opts.maxAttempts) ? opts.maxAttempts : 100);
}

export function noGuessAttemptSeed(baseSeed, safeIdx, attempt) {
  return `${baseSeed}:noguess:${safeIdx}:${attempt}`;
}

// Search for a layout that a bounded player can fully clear from safeIdx.
// Returns { seed, layout } on success, or { failed: true, reason } after the attempt cap.
export function generateNoGuess(baseSeed, w, h, mineCount, safeIdx, opts = {}) {
  const maxAttempts = normalizeAttempts(opts);
  const componentCap = Number.isInteger(opts.componentCap) ? opts.componentCap : TANK_COMPONENT_CAP;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const seed = noGuessAttemptSeed(baseSeed, safeIdx, attempt);
    const layout = generateBoard(seed, w, h, mineCount, safeIdx);
    if (layout.counts[safeIdx] !== 0) {
      continue;
    }
    const verified = tankSolves(layout, safeIdx, { componentCap });
    if (verified.solved) {
      return { seed, attempt, layout };
    }
  }

  return { failed: true, reason: "no_solvable_board" };
}
