import { defineConfig } from "vitest/config";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

process.env.XDG_CONFIG_HOME ??= new URL("./.wrangler-config", import.meta.url).pathname;
process.env.WRANGLER_SEND_METRICS ??= "false";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "engine",
          include: ["engine/test/**/*.test.js"],
          environment: "node"
        }
      },
      {
        test: {
          name: "client",
          include: ["client/test/**/*.test.js"],
          environment: "node"
        }
      },
      defineWorkersProject({
        test: {
          name: "server",
          include: ["server/test/**/*.test.js"],
          pool: "@cloudflare/vitest-pool-workers",
          poolOptions: {
            workers: {
              main: "./server/src/index.js",
              isolatedStorage: true,
              singleWorker: true,
              miniflare: {
                compatibilityDate: "2025-09-06",
                durableObjects: {
                  GAME: { className: "GameRoom", useSQLite: true },
                  LEADERBOARD: { className: "Leaderboard", useSQLite: true }
                }
              }
            }
          }
        }
      })
    ]
  }
});
