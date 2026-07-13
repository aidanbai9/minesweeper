export { makeRng } from "./rng.js";
export { generateBoard, InvalidBoardConfigError } from "./board.js";
export { neighbors, floodOpen } from "./neighbors.js";
export {
  Status,
  AUTO_FLAG,
  PRESETS,
  clampInt,
  normalizeConfig,
  assertConfig,
  createGame,
  applyAction
} from "./rules.js";
