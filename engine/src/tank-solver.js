import { floodOpen, neighbors } from "./neighbors.js";

export const TANK_COMPONENT_CAP = 32;

function totalCells(config) {
  return config.w * config.h;
}

function countOnes(mask) {
  let out = 0;
  for (const value of mask) {
    if (value) out += 1;
  }
  return out;
}

function listFromMask(mask) {
  const out = [];
  for (let idx = 0; idx < mask.length; idx += 1) {
    if (mask[idx]) out.push(idx);
  }
  return out;
}

function cloneKnown(known, total) {
  return {
    counts: known.counts,
    revealed: new Uint8Array(known.revealed || total),
    flags: new Uint8Array(known.flags || total),
    safe: new Uint8Array(known.safe || total)
  };
}

function constraintAt(state, config, idx) {
  let flagged = 0;
  const cells = [];
  for (const n of neighbors(idx, config.w, config.h)) {
    if (state.flags[n]) flagged += 1;
    else if (!state.revealed[n] && !state.safe[n]) cells.push(n);
  }
  return { idx, need: Number(state.counts[idx]) - flagged, cells };
}

function collectConstraints(state, config) {
  const constraints = [];
  for (let idx = 0; idx < totalCells(config); idx += 1) {
    if (!state.revealed[idx]) continue;
    const c = constraintAt(state, config, idx);
    if (c.need < 0 || c.need > c.cells.length) return { contradiction: true, constraints: [] };
    if (c.cells.length > 0) constraints.push(c);
  }
  return { contradiction: false, constraints };
}

function buildComponents(config, constraints) {
  const total = totalCells(config);
  const frontier = new Uint8Array(total);
  const cellToConstraints = Array.from({ length: total }, () => []);
  constraints.forEach((constraint, ci) => {
    for (const cell of constraint.cells) {
      frontier[cell] = 1;
      cellToConstraints[cell].push(ci);
    }
  });

  const seenCell = new Uint8Array(total);
  const seenConstraint = new Uint8Array(constraints.length);
  const components = [];
  for (let start = 0; start < total; start += 1) {
    if (!frontier[start] || seenCell[start]) continue;
    const cells = [];
    const constraintIds = [];
    const queue = [start];
    seenCell[start] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const cell = queue[head];
      cells.push(cell);
      for (const ci of cellToConstraints[cell]) {
        if (!seenConstraint[ci]) {
          seenConstraint[ci] = 1;
          constraintIds.push(ci);
        }
        for (const next of constraints[ci].cells) {
          if (!seenCell[next]) {
            seenCell[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    cells.sort((a, b) => a - b);
    components.push({
      cells,
      constraints: constraintIds.sort((a, b) => a - b).map((ci) => constraints[ci])
    });
  }
  components.sort((a, b) => a.cells[0] - b.cells[0]);
  return { frontier, components };
}

function enumerateComponent(component, cap) {
  if (component.cells.length > cap) {
    return { capped: true, assignments: [], minMines: 0, maxMines: component.cells.length };
  }
  const pos = new Map(component.cells.map((cell, i) => [cell, i]));
  const checks = component.constraints.map((constraint) => ({
    need: constraint.need,
    positions: constraint.cells.map((cell) => pos.get(cell)),
    assigned: 0,
    mines: 0
  }));
  const cellChecks = Array.from({ length: component.cells.length }, () => []);
  checks.forEach((check, ci) => {
    for (const p of check.positions) cellChecks[p].push(ci);
  });

  const assignments = [];
  const values = new Int8Array(component.cells.length);
  values.fill(-1);

  function canContinue(ci) {
    const check = checks[ci];
    const remaining = check.positions.length - check.assigned;
    return check.mines <= check.need && check.mines + remaining >= check.need;
  }

  function backtrack(i, mask, mineCount) {
    if (i === component.cells.length) {
      for (const check of checks) {
        if (check.mines !== check.need) return;
      }
      assignments.push({ mask, mineCount });
      return;
    }
    for (const value of [0, 1]) {
      values[i] = value;
      let ok = true;
      for (const ci of cellChecks[i]) {
        checks[ci].assigned += 1;
        checks[ci].mines += value;
        if (!canContinue(ci)) ok = false;
      }
      if (ok) backtrack(i + 1, value ? mask | (1n << BigInt(i)) : mask, mineCount + value);
      for (const ci of cellChecks[i]) {
        checks[ci].assigned -= 1;
        checks[ci].mines -= value;
      }
      values[i] = -1;
    }
  }

  backtrack(0, 0n, 0);
  if (assignments.length === 0) return { contradiction: true, assignments: [] };
  return {
    capped: false,
    assignments,
    minMines: Math.min(...assignments.map((a) => a.mineCount)),
    maxMines: Math.max(...assignments.map((a) => a.mineCount))
  };
}

function possibleSums(ranges, seaCount) {
  const max = ranges.reduce((sum, r) => sum + r.maxMines, seaCount);
  let possible = new Uint8Array(max + 1);
  possible[0] = 1;
  let limit = 0;
  for (const range of ranges) {
    const next = new Uint8Array(max + 1);
    for (let sum = 0; sum <= limit; sum += 1) {
      if (!possible[sum]) continue;
      for (let m = range.minMines; m <= range.maxMines; m += 1) next[sum + m] = 1;
    }
    limit += range.maxMines;
    possible = next;
  }
  const next = new Uint8Array(max + 1);
  for (let sum = 0; sum <= limit; sum += 1) {
    if (!possible[sum]) continue;
    for (let sea = 0; sea <= seaCount; sea += 1) next[sum + sea] = 1;
  }
  return next;
}

function canReachTotal(ranges, skip, fixed, seaCount, target) {
  const rest = ranges.filter((_, i) => i !== skip);
  const sums = possibleSums(rest, seaCount);
  const need = target - fixed;
  return need >= 0 && need < sums.length && sums[need];
}

export function findTankForcedMoves(known, config, opts = {}) {
  const total = totalCells(config);
  const cap = Number.isInteger(opts.componentCap) ? opts.componentCap : TANK_COMPONENT_CAP;
  const useGlobal = opts.useGlobalMineCount !== false;
  const state = cloneKnown(known, total);
  const stats = opts.stats || {};
  stats.calls = (stats.calls || 0) + 1;

  const mineOut = new Uint8Array(total);
  const safeOut = new Uint8Array(total);
  let changed = true;
  while (changed) {
    changed = false;
    const { contradiction, constraints } = collectConstraints(state, config);
    if (contradiction) return { contradiction: true, safe: [], mines: [], capped: false };

    for (const c of constraints) {
      if (c.need === 0) {
        for (const cell of c.cells) {
          if (!state.safe[cell]) {
            state.safe[cell] = 1;
            safeOut[cell] = 1;
            changed = true;
          }
        }
      } else if (c.need === c.cells.length) {
        for (const cell of c.cells) {
          if (state.safe[cell]) return { contradiction: true, safe: [], mines: [], capped: false };
          if (!state.flags[cell]) {
            state.flags[cell] = 1;
            mineOut[cell] = 1;
            changed = true;
          }
        }
      }
    }
  }

  const { contradiction, constraints } = collectConstraints(state, config);
  if (contradiction) return { contradiction: true, safe: [], mines: [], capped: false };
  const { frontier, components } = buildComponents(config, constraints);
  stats.maxComponent = Math.max(stats.maxComponent || 0, ...components.map((c) => c.cells.length), 0);
  const enumerated = components.map((c) => enumerateComponent(c, cap));
  if (enumerated.some((e) => e.contradiction)) return { contradiction: true, safe: [], mines: [], capped: false };
  const capped = enumerated.some((e) => e.capped);
  if (capped) stats.capHits = (stats.capHits || 0) + 1;

  let seaCount = 0;
  const sea = [];
  for (let idx = 0; idx < total; idx += 1) {
    if (!state.revealed[idx] && !state.flags[idx] && !state.safe[idx] && !frontier[idx]) {
      seaCount += 1;
      sea.push(idx);
    }
  }

  const remaining = config.mineCount - countOnes(state.flags);
  if (remaining < 0 || remaining > seaCount + enumerated.reduce((sum, e) => sum + e.maxMines, 0)) {
    return { contradiction: true, safe: [], mines: [], capped };
  }

  const ranges = enumerated.map((e) => ({ minMines: e.minMines, maxMines: e.maxMines }));
  const sums = useGlobal ? possibleSums(ranges, seaCount) : null;
  if (useGlobal && (remaining >= sums.length || !sums[remaining])) {
    return { contradiction: true, safe: [], mines: [], capped };
  }

  for (let ci = 0; ci < components.length; ci += 1) {
    const component = components[ci];
    const info = enumerated[ci];
    if (info.capped) continue;
    for (let bit = 0; bit < component.cells.length; bit += 1) {
      let minePossible = false;
      let safePossible = false;
      for (const assignment of info.assignments) {
        if (useGlobal && !canReachTotal(ranges, ci, assignment.mineCount, seaCount, remaining)) continue;
        if ((assignment.mask & (1n << BigInt(bit))) !== 0n) minePossible = true;
        else safePossible = true;
        if (minePossible && safePossible) break;
      }
      const cell = component.cells[bit];
      if (minePossible && !safePossible) mineOut[cell] = 1;
      else if (safePossible && !minePossible) safeOut[cell] = 1;
    }
  }

  if (useGlobal) {
    const componentMin = ranges.reduce((sum, r) => sum + r.minMines, 0);
    const componentMax = ranges.reduce((sum, r) => sum + r.maxMines, 0);
    if (remaining === componentMin) {
      for (const cell of sea) safeOut[cell] = 1;
    } else if (remaining - componentMax === seaCount) {
      for (const cell of sea) mineOut[cell] = 1;
    }
  }

  return { safe: listFromMask(safeOut), mines: listFromMask(mineOut), capped, contradiction: false };
}

function reveal(layout, known, idx) {
  const opened = floodOpen(layout, idx, known.revealed, known.flags);
  for (const cell of opened) known.revealed[cell] = 1;
  return opened.length;
}

export function tankSolves(layout, safeIdx = layout.safeIdx, opts = {}) {
  const config = { w: layout.w, h: layout.h, mineCount: layout.mineCount };
  const total = totalCells(config);
  const known = { counts: layout.counts, revealed: new Uint8Array(total), flags: new Uint8Array(total), safe: new Uint8Array(total) };
  const stats = opts.stats || {};
  if (layout.mines[safeIdx]) return { solved: false, reason: "safe_mined", stats };
  reveal(layout, known, safeIdx);
  for (let iter = 0; iter < total * 2; iter += 1) {
    if (countOnes(known.revealed) === total - layout.mineCount) return { solved: true, stats };
    const before = countOnes(known.revealed) + countOnes(known.flags) + countOnes(known.safe);
    const forced = findTankForcedMoves(known, config, { ...opts, stats });
    if (forced.contradiction) return { solved: false, reason: "contradiction", stats };
    if (forced.capped) stats.solveCapHits = (stats.solveCapHits || 0) + 1;
    for (const idx of forced.mines) {
      if (!known.revealed[idx]) known.flags[idx] = 1;
    }
    for (const idx of forced.safe) {
      if (!known.flags[idx] && !known.revealed[idx]) {
        if (layout.mines[idx]) return { solved: false, reason: "unsound_safe", stats };
        known.safe[idx] = 1;
        reveal(layout, known, idx);
      }
    }
    const after = countOnes(known.revealed) + countOnes(known.flags) + countOnes(known.safe);
    if (after === before) return { solved: false, reason: forced.capped ? "capped_stuck" : "stuck", stats };
  }
  return { solved: false, reason: "max_iterations", stats };
}

export function makeKnownAfterFirstClick(layout, safeIdx = layout.safeIdx) {
  const total = layout.w * layout.h;
  const known = { counts: layout.counts, revealed: new Uint8Array(total), flags: new Uint8Array(total), safe: new Uint8Array(total) };
  reveal(layout, known, safeIdx);
  return known;
}
