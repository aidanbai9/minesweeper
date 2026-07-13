# Collaborative Minesweeper

Classic Minesweeper with two modes:

- Online co-op: GitHub Pages hosts the static client; Cloudflare Workers routes room WebSockets to a SQLite-backed Durable Object. Everyone on the same `#r=<code>` link plays the same room in real time.
- Offline solo: `#s=<seed>&w=&h=&m=` runs the shared engine entirely in the browser. The same seed/config opens the same board without contacting the Worker.

## Setup

```sh
npm install
npm run sync-engine
```

## Development

Run the Worker:

```sh
npm run dev:server
```

Run the static client:

```sh
npm run dev:client
```

Open `http://localhost:8080`. Use the menu, or open two tabs with the same room hash, for example `http://localhost:8080/#r=abcde234&w=9&h=9&m=10`.

The client defaults to `ws://localhost:8787`. For GitHub Pages, set the repository variable `WS_BASE` to your deployed Worker origin, for example `wss://minesweeper-server.<subdomain>.workers.dev`.

## Tests

```sh
npm test
```

The engine tests run in plain Node. The server tests run in the Cloudflare Workers Vitest pool and exercise real WebSocket upgrades against the Durable Object.

## Controls Acceptance

- Space over a covered cell toggles a flag; over a revealed number it chords; over a revealed blank it does nothing.
- Holding space fires exactly once.
- Space on a number with the wrong adjacent flag count is a silent no-op, not an error or detonation.

## Deploy

Worker:

```sh
npm run deploy
```

Client:

The `pages.yml` workflow syncs `engine/src/*.js` into `client/engine/` and deploys `client/` to GitHub Pages.

## Anti-Cheat

Online snapshots expose only dimensions, counts for revealed cells, flags, peers, and status. The server seed and mine array remain in Durable Object storage. The full mine list is sent only in terminal `BOOM` or `WIN` events.

Offline solo intentionally uses the seed in the URL and runs the same pure engine in-tab, so it has no server anti-cheat boundary.
