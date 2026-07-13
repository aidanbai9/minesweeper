import { GameRoom } from "./GameRoom.js";
import { Leaderboard } from "./Leaderboard.js";
import { isValidRoomCode } from "./ids.js";

export { GameRoom, Leaderboard };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function text(body, status = 200) {
  return new Response(body, { status, headers: CORS });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return text("ok");
    }

    if (request.method === "GET" && url.pathname === "/leaderboard") {
      const boards = await env.LEADERBOARD.getByName("global").getBoards();
      return json(boards, 200, { "Cache-Control": "public, max-age=30" });
    }

    const match = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && match) {
      const code = match[1];
      if (!isValidRoomCode(code)) {
        return text("bad room code", 400);
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return text("websocket upgrade required", 426);
      }
      return env.GAME.getByName(code).fetch(request);
    }

    return text("not found", 404);
  }
};
