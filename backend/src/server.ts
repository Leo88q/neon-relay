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
import { RewardService, RewardsError } from "./rewards.ts";
import { SessionStore } from "./sessions.ts";
import { WalletStore } from "./wallets.ts";
import {
  bearerToken, clientIp, HttpError, readJsonBody, sendJson,
  type RequestContext,
} from "./http.ts";
import { authFailureStatus, buildRouter } from "./routes.ts";

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
      const handler = router.resolve(req.method ?? "GET", path);
      if (!handler) {
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
      };
      const result = await handler(ctx);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      } else if (err instanceof AuthFailure) {
        sendJson(res, authFailureStatus(err.code),
          { error: { code: err.code, message: err.message } });
      } else if (err instanceof RewardsError) {
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
  console.log(`neonrelay-backend listening on :${port} (domain ${app.config.authDomain})`);
  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
