import { AUTO_FLAG } from "../engine/index.js";

const PEER_COUNT = 8;

export function peerFallbackColor(playerId) {
  if (!Number.isInteger(playerId)) {
    return "black";
  }
  const index = ((playerId % PEER_COUNT) + PEER_COUNT) % PEER_COUNT;
  return getComputedStyle(document.documentElement).getPropertyValue(`--peer-${index}`).trim() || "black";
}

export function createPresence(cells, peerListEl) {
  const peers = new Map();
  const cursors = new Map();
  const dirtyCursorCells = new Set();
  let currentYouId = null;
  let cursorFrame = 0;

  function colorFor(playerId) {
    if (playerId === AUTO_FLAG || playerId === AUTO_FLAG - 1) {
      return getComputedStyle(document.documentElement).getPropertyValue("--flag-cloth").trim() || "red";
    }
    return peers.get(playerId)?.color || peerFallbackColor(playerId);
  }

  function peerCount() {
    return peers.size;
  }

  function cursorsAt(idx) {
    const list = [];
    for (const [playerId, cursorIdx] of cursors) {
      if (cursorIdx === idx) {
        list.push({ playerId, color: colorFor(playerId) });
      }
    }
    return list;
  }

  function refreshCell(idx) {
    const cell = cells[idx];
    if (!cell) {
      return;
    }
    const outlines = cursorsAt(idx);
    cell.style.boxShadow = outlines
      .map((cursor, i) => `inset 0 0 0 ${2 + i}px ${cursor.color}`)
      .join(", ");
  }

  function cancelCursorRender() {
    if (cursorFrame) {
      cancelAnimationFrame(cursorFrame);
      cursorFrame = 0;
    }
    dirtyCursorCells.clear();
  }

  function flushCursorCells() {
    cursorFrame = 0;
    const indices = [...dirtyCursorCells];
    dirtyCursorCells.clear();
    for (const idx of indices) {
      refreshCell(idx);
    }
  }

  function queueCursorCell(idx) {
    if (idx < 0 || idx >= cells.length) {
      return;
    }
    dirtyCursorCells.add(idx);
    if (!cursorFrame) {
      cursorFrame = requestAnimationFrame(flushCursorCells);
    }
  }

  function refreshAll() {
    cancelCursorRender();
    for (let idx = 0; idx < cells.length; idx += 1) {
      refreshCell(idx);
    }
  }

  function renderPeerList(youId) {
    const ordered = [...peers.values()].sort((a, b) => a.playerId - b.playerId);
    peerListEl.hidden = ordered.length < 2;
    peerListEl.replaceChildren();
    for (const peer of ordered) {
      const item = document.createElement("span");
      item.className = `peer${peer.playerId === youId ? " you" : ""}`;

      const dot = document.createElement("span");
      dot.className = "peer-dot";
      dot.style.background = colorFor(peer.playerId);

      const name = document.createElement("span");
      name.textContent = peer.name;

      item.append(dot, name);
      peerListEl.append(item);
    }
  }

  return {
    setPeers(peerList, you) {
      currentYouId = you?.playerId ?? null;
      peers.clear();
      if (you) {
        peers.set(you.playerId, you);
      }
      for (const peer of peerList || []) {
        peers.set(peer.playerId, peer);
      }
      renderPeerList(you?.playerId);
      refreshAll();
    },
    upsertPeer(peer, youId) {
      currentYouId = youId ?? currentYouId;
      peers.set(peer.playerId, peer);
      renderPeerList(youId);
      refreshAll();
    },
    removePeer(playerId, youId) {
      currentYouId = youId ?? currentYouId;
      peers.delete(playerId);
      cursors.delete(playerId);
      renderPeerList(youId);
      refreshAll();
    },
    setCursor(playerId, idx) {
      const old = cursors.get(playerId);
      if (old === idx) {
        return;
      }
      if (idx < 0) {
        cursors.delete(playerId);
      } else {
        cursors.set(playerId, idx);
      }
      if (old !== undefined) {
        queueCursorCell(old);
      }
      queueCursorCell(idx);
    },
    colorFor,
    peerCount,
    refreshCell,
    refreshAll
  };
}
