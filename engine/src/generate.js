import { generateBoard } from "./board.js";
import { solves } from "./solver.js";

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
  const config = { w, h, mineCount };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const seed = noGuessAttemptSeed(baseSeed, safeIdx, attempt);
    const layout = generateBoard(seed, w, h, mineCount, safeIdx);
    if (solves(layout, safeIdx, config, opts)) {
      return { seed, attempt, layout };
    }
  }

  return { failed: true, reason: "no_solvable_board" };
}
