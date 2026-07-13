import { AUTO_FLAG } from "../engine/index.js";

export const CLASSIC_FLAG_COLOR = "#ff0000";
export const PEER_PALETTE = Object.freeze([
  "#0000ff",
  "#008000",
  "#800080",
  "#008080",
  "#800000",
  "#000080",
  "#808000",
  "#ff7f00"
]);

export function createPresence(cells, peerListEl) {
  const peers = new Map();
  const cursors = new Map();
  let currentYouId = null;

  function isClassicFlagRed(color) {
    return color?.toLowerCase() === "#ff0000" || color?.toLowerCase() === "#f00";
  }

  function colorFor(playerId) {
    if (playerId === AUTO_FLAG || playerId === AUTO_FLAG - 1) {
      return CLASSIC_FLAG_COLOR;
    }
    const fallback = Number.isInteger(playerId) ? PEER_PALETTE[playerId % PEER_PALETTE.length] : "#000000";
    const color = peers.get(playerId)?.color || fallback;
    return isClassicFlagRed(color) ? fallback : color;
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

  function refreshAll() {
    for (let idx = 0; idx < cells.length; idx += 1) {
      refreshCell(idx);
    }
  }

  function renderPeerList(youId) {
    const ordered = [...peers.values()].sort((a, b) => a.playerId - b.playerId);
    peerListEl.hidden = ordered.length < 2;
    peerListEl.innerHTML = ordered
      .map(
        (peer) => `
          <span class="peer ${peer.playerId === youId ? "you" : ""}">
            <span class="peer-dot" style="background:${colorFor(peer.playerId)}"></span>
            <span>${peer.name}</span>
          </span>
        `
      )
      .join("");
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
      cursors.set(playerId, idx);
      if (old !== undefined) {
        refreshCell(old);
      }
      refreshCell(idx);
    },
    colorFor,
    peerCount,
    refreshCell,
    refreshAll
  };
}
