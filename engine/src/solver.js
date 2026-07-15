import { floodOpen, neighbors } from "./neighbors.js";

function optsWithDefaults(opts = {}) {
  return {
    maxDepth: Math.max(0, Number.isInteger(opts.maxDepth) ? opts.maxDepth : 0),
    maxWidth: Math.max(1, Number.isInteger(opts.maxWidth) ? opts.maxWidth : 16),
    useGlobalMineCount: opts.useGlobalMineCount !== false
  };
}

function totalCells(config) {
  return config.w * config.h;
}

function countOnes(values) {
  let count = 0;
  for (let idx = 0; idx < values.length; idx += 1) {
    if (values[idx]) {
      count += 1;
    }
  }
  return count;
}

function sortedFromMask(mask) {
  const out = [];
  for (let idx = 0; idx < mask.length; idx += 1) {
    if (mask[idx]) {
      out.push(idx);
    }
  }
  return out;
}

function cloneReasonState(known, config) {
  const total = totalCells(config);
  const revealed = new Uint8Array(total);
  const flags = new Uint8Array(total);
  const safe = new Uint8Array(total);
  const counts = known.counts;

  for (let idx = 0; idx < total; idx += 1) {
    revealed[idx] = known.revealed?.[idx] ? 1 : 0;
    flags[idx] = known.flags?.[idx] ? 1 : 0;
    safe[idx] = known.safe?.[idx] ? 1 : 0;
  }

  return { revealed, flags, safe, counts, config };
}

function revealedCountAt(state, idx) {
  if (!state.revealed[idx]) {
    return 0;
  }
  if (!state.counts || !Number.isInteger(Number(state.counts[idx]))) {
    throw new Error("findForcedMoves requires known.counts for revealed cells");
  }
  return Number(state.counts[idx]);
}

function addSafe(state, idx) {
  if (state.revealed[idx] || state.flags[idx] || state.safe[idx]) {
    return false;
  }
  state.safe[idx] = 1;
  return true;
}

function addMine(state, idx) {
  if (state.revealed[idx] || state.flags[idx]) {
    return false;
  }
  if (state.safe[idx]) {
    return "contradiction";
  }
  state.flags[idx] = 1;
  return true;
}

function constraintFor(state, idx) {
  const around = neighbors(idx, state.config.w, state.config.h);
  let flagged = 0;
  const possible = [];
  for (const n of around) {
    if (state.flags[n]) {
      flagged += 1;
    } else if (!state.revealed[n] && !state.safe[n]) {
      possible.push(n);
    }
  }
  const need = revealedCountAt(state, idx) - flagged;
  return { idx, need, possible };
}

function propagateLocal(state, settings) {
  const total = totalCells(state.config);
  const safeOut = new Uint8Array(total);
  const mineOut = new Uint8Array(total);
  const maxPasses = Math.max(1, total * 16);
  let changed = true;
  let passes = 0;

  while (changed) {
    changed = false;
    passes += 1;
    if (passes > maxPasses) {
      throw new Error("solver propagation did not converge");
    }

    for (let idx = 0; idx < total; idx += 1) {
      if (!state.revealed[idx]) {
        continue;
      }
      const { need, possible } = constraintFor(state, idx);
      if (need < 0 || need > possible.length) {
        return { contradiction: true, safeOut, mineOut };
      }
      if (possible.length === 0) {
        continue;
      }
      if (need === 0) {
        for (const n of possible) {
          if (addSafe(state, n)) {
            safeOut[n] = 1;
            changed = true;
          }
        }
      } else if (need === possible.length) {
        for (const n of possible) {
          const added = addMine(state, n);
          if (added === "contradiction") {
            return { contradiction: true, safeOut, mineOut };
          }
          if (added) {
            mineOut[n] = 1;
            changed = true;
          }
        }
      }
    }

    if (settings.useGlobalMineCount) {
      const flagged = countOnes(state.flags);
      const remaining = state.config.mineCount - flagged;
      let possibleCount = 0;
      for (let idx = 0; idx < total; idx += 1) {
        if (!state.revealed[idx] && !state.flags[idx] && !state.safe[idx]) {
          possibleCount += 1;
        }
      }
      if (remaining < 0 || remaining > possibleCount) {
        return { contradiction: true, safeOut, mineOut };
      }
      if (remaining === 0 || remaining === possibleCount) {
        for (let idx = 0; idx < total; idx += 1) {
          if (state.revealed[idx] || state.flags[idx] || state.safe[idx]) {
            continue;
          }
          if (remaining === 0) {
            if (addSafe(state, idx)) {
              safeOut[idx] = 1;
              changed = true;
            }
          } else {
            const added = addMine(state, idx);
            if (added === "contradiction") {
              return { contradiction: true, safeOut, mineOut };
            }
            if (added) {
              mineOut[idx] = 1;
              changed = true;
            }
          }
        }
      }
    }
  }

  return { contradiction: false, safeOut, mineOut };
}

function constraints(state) {
  const out = [];
  const total = totalCells(state.config);
  for (let idx = 0; idx < total; idx += 1) {
    if (!state.revealed[idx]) {
      continue;
    }
    const constraint = constraintFor(state, idx);
    if (constraint.need < 0 || constraint.need > constraint.possible.length) {
      return { contradiction: true, constraints: [] };
    }
    if (constraint.possible.length > 0) {
      out.push(constraint);
    }
  }
  return { contradiction: false, constraints: out };
}

function buildComponents(state, allConstraints) {
  const total = totalCells(state.config);
  const cellToConstraints = Array.from({ length: total }, () => []);
  const frontier = new Uint8Array(total);

  for (let ci = 0; ci < allConstraints.length; ci += 1) {
    for (const cell of allConstraints[ci].possible) {
      frontier[cell] = 1;
      cellToConstraints[cell].push(ci);
    }
  }

  const seenCell = new Uint8Array(total);
  const seenConstraint = new Uint8Array(allConstraints.length);
  const components = [];

  for (let start = 0; start < total; start += 1) {
    if (!frontier[start] || seenCell[start]) {
      continue;
    }
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
        for (const next of allConstraints[ci].possible) {
          if (!seenCell[next]) {
            seenCell[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    cells.sort((a, b) => a - b);
    constraintIds.sort((a, b) => a - b);
    components.push({ cells, constraints: constraintIds.map((ci) => allConstraints[ci]) });
  }

  components.sort((a, b) => a.cells[0] - b.cells[0]);
  return { components, frontier };
}

function enumerateComponent(component, maxWidth) {
  const width = component.cells.length;
  if (width > maxWidth) {
    return { bounded: false, minMines: 0, maxMines: width, assignments: [] };
  }

  const pos = new Map();
  component.cells.forEach((cell, i) => pos.set(cell, i));
  const checks = component.constraints.map((constraint) => ({
    need: constraint.need,
    positions: constraint.possible.map((cell) => pos.get(cell))
  }));
  const assignments = [];
  const totalMasks = 1n << BigInt(width);

  for (let mask = 0n; mask < totalMasks; mask += 1n) {
    let ok = true;
    for (const check of checks) {
      let mines = 0;
      for (const bit of check.positions) {
        if ((mask & (1n << BigInt(bit))) !== 0n) {
          mines += 1;
        }
      }
      if (mines !== check.need) {
        ok = false;
        break;
      }
    }
    if (ok) {
      let mineCount = 0;
      for (let bit = 0; bit < width; bit += 1) {
        if ((mask & (1n << BigInt(bit))) !== 0n) {
          mineCount += 1;
        }
      }
      assignments.push({ mask, mineCount });
    }
  }

  if (assignments.length === 0) {
    return { bounded: true, contradiction: true, assignments };
  }
  return {
    bounded: true,
    minMines: Math.min(...assignments.map((a) => a.mineCount)),
    maxMines: Math.max(...assignments.map((a) => a.mineCount)),
    assignments
  };
}

function possibleSums(ranges, unconstrainedCount) {
  const max = ranges.reduce((sum, range) => sum + range.maxMines, unconstrainedCount);
  let possible = new Uint8Array(max + 1);
  possible[0] = 1;
  let limit = 0;
  for (const range of ranges) {
    const next = new Uint8Array(max + 1);
    for (let sum = 0; sum <= limit; sum += 1) {
      if (!possible[sum]) {
        continue;
      }
      for (let mines = range.minMines; mines <= range.maxMines; mines += 1) {
        next[sum + mines] = 1;
      }
    }
    limit += range.maxMines;
    possible = next;
  }
  const next = new Uint8Array(max + 1);
  for (let sum = 0; sum <= limit; sum += 1) {
    if (!possible[sum]) {
      continue;
    }
    for (let mines = 0; mines <= unconstrainedCount; mines += 1) {
      next[sum + mines] = 1;
    }
  }
  return next;
}

function canReachTotal(ranges, skip, fixedMines, unconstrainedCount, target) {
  const rest = [];
  for (let i = 0; i < ranges.length; i += 1) {
    if (i !== skip) {
      rest.push(ranges[i]);
    }
  }
  const sums = possibleSums(rest, unconstrainedCount);
  const need = target - fixedMines;
  return need >= 0 && need < sums.length && sums[need] === 1;
}

function applyComponentGlobal(state, settings) {
  if (!settings.useGlobalMineCount) {
    return { contradiction: false, safeOut: new Uint8Array(totalCells(state.config)), mineOut: new Uint8Array(totalCells(state.config)) };
  }

  const total = totalCells(state.config);
  const { contradiction, constraints: allConstraints } = constraints(state);
  if (contradiction) {
    return { contradiction: true, safeOut: new Uint8Array(total), mineOut: new Uint8Array(total) };
  }
  const { components, frontier } = buildComponents(state, allConstraints);
  const enumerated = components.map((component) => enumerateComponent(component, settings.maxWidth));
  if (enumerated.some((component) => component.contradiction)) {
    return { contradiction: true, safeOut: new Uint8Array(total), mineOut: new Uint8Array(total) };
  }

  let unconstrainedCount = 0;
  const unconstrained = [];
  for (let idx = 0; idx < total; idx += 1) {
    if (!state.revealed[idx] && !state.flags[idx] && !state.safe[idx] && !frontier[idx]) {
      unconstrainedCount += 1;
      unconstrained.push(idx);
    }
  }

  const remaining = state.config.mineCount - countOnes(state.flags);
  const ranges = enumerated.map((component) => ({
    minMines: component.minMines,
    maxMines: component.maxMines
  }));
  const sums = possibleSums(ranges, unconstrainedCount);
  if (remaining < 0 || remaining >= sums.length || !sums[remaining]) {
    return { contradiction: true, safeOut: new Uint8Array(total), mineOut: new Uint8Array(total) };
  }

  const safeOut = new Uint8Array(total);
  const mineOut = new Uint8Array(total);

  for (let ci = 0; ci < components.length; ci += 1) {
    const component = components[ci];
    const info = enumerated[ci];
    if (!info.bounded) {
      continue;
    }
    for (let bit = 0; bit < component.cells.length; bit += 1) {
      let minePossible = false;
      let safePossible = false;
      for (const assignment of info.assignments) {
        if (!canReachTotal(ranges, ci, assignment.mineCount, unconstrainedCount, remaining)) {
          continue;
        }
        if ((assignment.mask & (1n << BigInt(bit))) !== 0n) {
          minePossible = true;
        } else {
          safePossible = true;
        }
      }
      const cell = component.cells[bit];
      if (minePossible && !safePossible) {
        const added = addMine(state, cell);
        if (added === "contradiction") {
          return { contradiction: true, safeOut, mineOut };
        }
        if (added) {
          mineOut[cell] = 1;
        }
      } else if (safePossible && !minePossible && addSafe(state, cell)) {
        safeOut[cell] = 1;
      }
    }
  }

  if (unconstrained.length > 0) {
    const componentMin = ranges.reduce((sum, range) => sum + range.minMines, 0);
    const componentMax = ranges.reduce((sum, range) => sum + range.maxMines, 0);
    if (remaining - componentMax === unconstrained.length) {
      for (const cell of unconstrained) {
        const added = addMine(state, cell);
        if (added === "contradiction") {
          return { contradiction: true, safeOut, mineOut };
        }
        if (added) {
          mineOut[cell] = 1;
        }
      }
    } else if (remaining - componentMin === 0) {
      for (const cell of unconstrained) {
        if (addSafe(state, cell)) {
          safeOut[cell] = 1;
        }
      }
    }
  }

  return { contradiction: false, safeOut, mineOut };
}

function mergeMask(into, from) {
  let changed = false;
  for (let idx = 0; idx < into.length; idx += 1) {
    if (from[idx] && !into[idx]) {
      into[idx] = 1;
      changed = true;
    }
  }
  return changed;
}

function analyze(known, config, settings) {
  const state = cloneReasonState(known, config);
  const total = totalCells(config);
  const safe = new Uint8Array(total);
  const mines = new Uint8Array(total);

  let changed = true;
  while (changed) {
    changed = false;
    const local = propagateLocal(state, settings);
    if (local.contradiction) {
      return { contradiction: true, safe, mines };
    }
    changed = mergeMask(safe, local.safeOut) || changed;
    changed = mergeMask(mines, local.mineOut) || changed;

    const global = applyComponentGlobal(state, settings);
    if (global.contradiction) {
      return { contradiction: true, safe, mines };
    }
    changed = mergeMask(safe, global.safeOut) || changed;
    changed = mergeMask(mines, global.mineOut) || changed;
  }

  if (settings.maxDepth <= 0) {
    return { contradiction: false, safe, mines };
  }

  const { constraints: allConstraints } = constraints(state);
  const { components } = buildComponents(state, allConstraints);
  for (const component of components) {
    if (component.cells.length > settings.maxWidth) {
      continue;
    }
    for (const cell of component.cells) {
      if (state.flags[cell] || state.safe[cell] || state.revealed[cell]) {
        continue;
      }

      const mineKnown = {
        counts: state.counts,
        revealed: state.revealed,
        flags: new Uint8Array(state.flags),
        safe: state.safe
      };
      mineKnown.flags[cell] = 1;
      const mineResult = analyze(mineKnown, config, { ...settings, maxDepth: settings.maxDepth - 1 });

      const safeKnown = {
        counts: state.counts,
        revealed: state.revealed,
        flags: state.flags,
        safe: state.safe
      };
      const safeState = cloneReasonState(safeKnown, config);
      safeState.safe.set(state.safe);
      safeState.safe[cell] = 1;
      const safeResult = analyze(
        { counts: safeState.counts, revealed: safeState.revealed, flags: safeState.flags, safe: safeState.safe },
        config,
        { ...settings, maxDepth: settings.maxDepth - 1 }
      );

      if (mineResult.contradiction && addSafe(state, cell)) {
        safe[cell] = 1;
      }
      if (safeResult.contradiction) {
        const added = addMine(state, cell);
        if (added === "contradiction") {
          return { contradiction: true, safe, mines };
        }
        if (added) {
          mines[cell] = 1;
        }
      }
    }
  }

  return { contradiction: false, safe, mines };
}

export function findForcedMoves(known, config, opts = {}) {
  const settings = optsWithDefaults(opts);
  const result = analyze(known, config, settings);
  if (result.contradiction) {
    return { safe: [], mines: [] };
  }
  return {
    safe: sortedFromMask(result.safe),
    mines: sortedFromMask(result.mines)
  };
}

function revealIntoKnown(layout, known, idx) {
  const opened = floodOpen(layout, idx, known.revealed, known.flags);
  for (const cell of opened) {
    known.revealed[cell] = 1;
  }
  return opened.length;
}

export function solves(layout, safeIdx, config, opts = {}) {
  const total = totalCells(config);
  if (layout.mines[safeIdx]) {
    return false;
  }
  const known = {
    counts: layout.counts,
    revealed: new Uint8Array(total),
    flags: new Uint8Array(total)
  };
  revealIntoKnown(layout, known, safeIdx);

  const maxIterations = Math.max(1, total * 2);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (countOnes(known.revealed) === total - config.mineCount) {
      return true;
    }
    const before = countOnes(known.revealed) + countOnes(known.flags);
    const forced = findForcedMoves(known, config, opts);
    for (const idx of forced.mines) {
      if (!known.revealed[idx]) {
        known.flags[idx] = 1;
      }
    }
    for (const idx of forced.safe) {
      if (!known.flags[idx] && !known.revealed[idx]) {
        if (layout.mines[idx]) {
          return false;
        }
        revealIntoKnown(layout, known, idx);
      }
    }
    const after = countOnes(known.revealed) + countOnes(known.flags);
    if (after === before) {
      return false;
    }
  }
  throw new Error("solver did not terminate");
}
