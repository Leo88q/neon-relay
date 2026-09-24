/**
 * HTTP server assembly and request dispatch.
 *
 * `createApp()` is pure (no listening) so tests can drive it with an ephemeral
 * port; `main()` is the production entry point.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadConfig, type Config } from "./config.ts";
import { Db, migrate } from "./db.ts";
import { AuthService, AuthFailure } from "./auth.ts";
import { AdminError, adminConfigured } from "./admin.ts";
import { GameEventsError } from "./game_events.ts";
import { RewardService, RewardsError } from "./rewards.ts";
import { SessionStore } from "./sessions.ts";
import { WalletStore } from "./wallets.ts";
import {
  bearerToken, clientIp, HttpError, readJsonBody, sendJson,
  type RequestContext,
} from "./http.ts";
import { authFailureStatus, buildRouter } from "./routes.ts";
import { ensureWatchtowerSchema } from "./watchtower.ts";

export interface App {
  server: Server;
  config: Config;
  db: Db;
  close: () => Promise<void>;
  listen: (port?: number) => Promise<number>;
}

export function createApp(config: Config = loadConfig()): App {
  const db = new Db(config.dbPath);
  migrate(db);
  ensureWatchtowerSchema(db);
  const wallets = new WalletStore(db);
  const sessions = new SessionStore(db, config.sessionTtlMs);
  const auth = new AuthService(config, wallets, sessions);
  const rewards = new RewardService(db, config, wallets);
  const router = buildRouter({ config, db, auth, wallets, sessions, rewards });

  const server = createServer((req, res) => {
    void dispatch(req, res);
  });

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      const resolved = router.resolve(req.method ?? "GET", path);
      if (!resolved) {
        throw new HttpError(404, "not-found", `no route for ${req.method} ${path}`);
      }
      const ctx: RequestContext = {
        method: req.method ?? "GET",
        path,
        url,
        ip: clientIp(req),
        body: req.method === "GET" || req.method === "HEAD"
          ? null
          : await readJsonBody(req),
        bearer: bearerToken(req),
        params: resolved.params,
      };
      const result = await resolved.handler(ctx);
      // Kubernetes-style readiness must be non-2xx while blocked. Liveness
      // remains a separate endpoint (`/watchtower/health`).
      const readinessBlocked = path === "/watchtower/readyz" &&
        typeof result === "object" && result !== null &&
        typeof (result as { data?: { ready?: unknown } }).data?.ready === "boolean" &&
        (result as { data: { ready: boolean } }).data.ready === false;
      sendJson(res, readinessBlocked ? 503 : 200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      } else if (err instanceof AuthFailure) {
        sendJson(res, authFailureStatus(err.code),
          { error: { code: err.code, message: err.message } });
      } else if (err instanceof RewardsError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      } else if (err instanceof AdminError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      } else if (err instanceof GameEventsError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        // never leak internals; the message goes to the log only
        console.error("unhandled error", err);
        sendJson(res, 500, { error: { code: "internal", message: "internal server error" } });
      }
    }
  }

  return {
    server,
    config,
    db,
    close: () => new Promise((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
    }),
    listen: (port?: number) => new Promise((resolve) => {
      server.listen(port ?? config.port, "0.0.0.0", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port ?? config.port);
      });
    }),
  };
}

export async function main(): Promise<void> {
  const app = createApp();
  const port = await app.listen();
  const adminMode = app.config.operatorToken && app.config.superadminToken
    ? "roles=operator+superadmin"
    : adminConfigured(app.config) ? "roles=legacy-single-token" : "roles=disabled";
  console.log(`neonrelay-backend listening on :${port} (domain ${app.config.authDomain}, ${adminMode})`);
  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
