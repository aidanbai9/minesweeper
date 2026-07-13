import { makeRng } from "./rng.js";
import { neighbors } from "./neighbors.js";

export class InvalidBoardConfigError extends RangeError {
  constructor(message) {
    super(message);
    this.name = "InvalidBoardConfigError";
  }
}

function assertBoardConfig(w, h, mineCount, safeIdx) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new InvalidBoardConfigError("Board dimensions must be positive integers");
  }
  const total = w * h;
  if (!Number.isInteger(safeIdx) || safeIdx < 0 || safeIdx >= total) {
    throw new InvalidBoardConfigError("safeIdx is outside the board");
  }
  if (!Number.isInteger(mineCount) || mineCount < 0) {
    throw new InvalidBoardConfigError("mineCount must be a non-negative integer");
  }
  if (mineCount > total - 9) {
    throw new InvalidBoardConfigError("Not enough non-mine cells for first-click safety");
  }
}

export function generateBoard(seed, w, h, mineCount, safeIdx) {
  assertBoardConfig(w, h, mineCount, safeIdx);

  const total = w * h;
  const mines = new Uint8Array(total);
  const counts = new Uint8Array(total);
  const excluded = new Uint8Array(total);
  excluded[safeIdx] = 1;
  for (const n of neighbors(safeIdx, w, h)) {
    excluded[n] = 1;
  }

  const eligible = [];
  for (let idx = 0; idx < total; idx += 1) {
    if (!excluded[idx]) {
      eligible.push(idx);
    }
  }

  if (mineCount > eligible.length) {
    throw new InvalidBoardConfigError("Not enough eligible cells for mine placement");
  }

  const rng = makeRng(`${seed}:${w}:${h}:${mineCount}:${safeIdx}`);
  for (let i = 0; i < mineCount; i += 1) {
    const j = i + rng.nextInt(eligible.length - i);
    const tmp = eligible[i];
    eligible[i] = eligible[j];
    eligible[j] = tmp;
    mines[eligible[i]] = 1;
  }

  for (let idx = 0; idx < total; idx += 1) {
    if (!mines[idx]) {
      continue;
    }
    for (const n of neighbors(idx, w, h)) {
      counts[n] += 1;
    }
  }

  return { w, h, mineCount, mines, counts, safeIdx };
}
