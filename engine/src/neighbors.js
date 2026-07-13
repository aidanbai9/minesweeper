export function neighbors(idx, w, h) {
  const r = Math.floor(idx / w);
  const c = idx % w;
  const out = [];

  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) {
        continue;
      }
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < h && nc >= 0 && nc < w) {
        out.push(nr * w + nc);
      }
    }
  }

  return out;
}

export function floodOpen(board, startIdx, revealed, flags = null) {
  if (
    startIdx < 0 ||
    startIdx >= board.w * board.h ||
    revealed[startIdx] ||
    (flags && flags[startIdx]) ||
    board.mines[startIdx]
  ) {
    return [];
  }

  const opened = [];
  const queued = new Uint8Array(board.w * board.h);
  const queue = [startIdx];
  queued[startIdx] = 1;

  for (let head = 0; head < queue.length; head += 1) {
    const idx = queue[head];
    if (revealed[idx] || (flags && flags[idx]) || board.mines[idx]) {
      continue;
    }

    opened.push(idx);

    if (board.counts[idx] !== 0) {
      continue;
    }

    for (const n of neighbors(idx, board.w, board.h)) {
      if (!queued[n] && !revealed[n] && !(flags && flags[n]) && !board.mines[n]) {
        queued[n] = 1;
        queue.push(n);
      }
    }
  }

  return opened;
}
