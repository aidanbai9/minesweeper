import { generateNoGuess } from "../engine/index.js";

self.addEventListener("message", (event) => {
  const { id, baseSeed, w, h, mineCount, safeIdx, maxAttempts, componentCap } = event.data || {};
  const started = performance.now();
  try {
    const result = generateNoGuess(baseSeed, w, h, mineCount, safeIdx, { maxAttempts, componentCap });
    if (result.failed) {
      self.postMessage({ id, failed: true, reason: result.reason, ms: performance.now() - started });
      return;
    }
    self.postMessage({
      id,
      seed: result.seed,
      attempt: result.attempt,
      ms: performance.now() - started
    });
  } catch (error) {
    self.postMessage({
      id,
      failed: true,
      reason: "worker_error",
      message: error?.message || "No-guess generation failed",
      ms: performance.now() - started
    });
  }
});
