/**
 * The engine's HTTP and WebSocket server.
 *
 * - It binds 127.0.0.1 only.
 * - Every route except /health needs the token: a bearer header, the cookie, or ?token=.
 * - A request with a foreign Host or Origin header is refused, so another web page cannot reach it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { DEFAULTS, home, paths } from "./config.ts";
import type { EngineEvent } from "./types.ts";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  body<T = Record<string, unknown>>(): Promise<T>;
}

/** A handler returns a value that becomes JSON, or a Response. */
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface Route {
  method: "GET" | "POST" | "PUT";
  path: string;
  handler: Handler;
}

export interface EngineInfo {
  pid: number;
  port: number;
  token: string;
}

export interface EngineServer {
  info: EngineInfo;
  url: string;
  publish(event: EngineEvent): void;
  clients(): number;
  stop(): void;
}

export interface ServerOptions {
  routes: Route[];
  hostname?: string;
  portFrom?: number;
  tries?: number;
  token?: string;
  /** The built page. Served for every path that is not /api or /health. */
  staticDir?: string;
}

export const LOOPBACK = "127.0.0.1";
const TOPIC = "events";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function match(pattern: string, pathname: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = pathname.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const p = a[i] ?? "";
    const v = b[i] ?? "";
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(v);
      } catch {
        return null;
      }
    } else if (p !== v) return null;
  }
  return params;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Every token the request carries: the bearer header, the `starship` cookie, and `?token=`.
 * The request is allowed when any one of them is right. A browser keeps the cookie of an older engine,
 * and that stale cookie must not block the address the new engine printed.
 */
function tokensOf(req: Request, url: URL): string[] {
  const out: string[] = [];
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) out.push(auth.slice(7).trim());
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)starship=([^;]+)/);
  if (m?.[1]) out.push(m[1]);
  const q = url.searchParams.get("token");
  if (q) out.push(q);
  return out;
}

function writeInfo(info: EngineInfo): void {
  mkdirSync(home(), { recursive: true });
  const file = paths.engine();
  // Write a new 0600 file and rename it, so the token never sits in a file that others can read.
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The folder refuses writes; there is nothing to clean.
    }
    throw e;
  }
}

/** What engine.json says, or null when there is none or it cannot be read. */
export function readInfo(): EngineInfo | null {
  try {
    const v = JSON.parse(readFileSync(paths.engine(), "utf8")) as Partial<EngineInfo>;
    if (typeof v.pid === "number" && typeof v.port === "number" && typeof v.token === "string") return { pid: v.pid, port: v.port, token: v.token };
  } catch {
    // no file, or not JSON
  }
  return null;
}

function staticFile(dir: string, pathname: string): Response | null {
  const root = resolve(dir);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  let file = resolve(root, "." + rel);
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file)) return null;
  return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" } });
}

export function startServer(opts: ServerOptions): EngineServer {
  const hostname = opts.hostname ?? LOOPBACK;
  if (hostname !== LOOPBACK) throw new Error(`The engine binds ${LOOPBACK} only, not ${hostname}`);
  const token = opts.token ?? randomBytes(32).toString("hex");
  const from = opts.portFrom ?? DEFAULTS.portFrom;
  const tries = opts.tries ?? 50;

  const handle = async (req: Request, server: Bun.Server<undefined>): Promise<Response | undefined> => {
    const url = new URL(req.url);
    const port = server.port;
    const host = req.headers.get("host") ?? "";
    if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return json({ error: "bad host" }, 403);
    if (url.pathname === "/health") return json({ ok: true, pid: process.pid });

    const origin = req.headers.get("origin");
    const ours = [`http://${LOOPBACK}:${port}`, `http://localhost:${port}`, "tauri://localhost"];
    // A WebSocket upgrade is a GET, but a foreign page can open one, so it is checked like a POST.
    const checked = req.method !== "GET" || url.pathname === "/api/events";
    if (origin && checked && !ours.includes(origin)) return json({ error: "bad origin" }, 403);

    if (!tokensOf(req, url).some((given) => same(given, token))) return json({ error: "token" }, 401);

    if (url.pathname === "/api/events") {
      if (server.upgrade(req, { data: undefined })) return undefined;
      return json({ error: "this address is a WebSocket" }, 400);
    }

    // `starship check` waits for a check that may run for minutes. Bun's idle limit would close that connection.
    if (req.method === "POST" && /^\/api\/chats\/[^/]+\/check$/.test(url.pathname)) server.timeout(req, 0);

    for (const route of opts.routes) {
      if (route.method !== req.method) continue;
      const params = match(route.path, url.pathname);
      if (!params) continue;
      const ctx: Ctx = {
        req,
        url,
        params,
        body: async <T>() => {
          try {
            return (await req.json()) as T;
          } catch {
            throw new HttpError(400, "the request body must be JSON");
          }
        },
      };
      const out = await route.handler(ctx);
      return out instanceof Response ? out : json(out ?? { ok: true });
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (opts.staticDir && req.method === "GET") {
      const res = staticFile(opts.staticDir, url.pathname);
      if (res) {
        if (url.searchParams.get("token")) res.headers.set("set-cookie", `starship=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return res;
      }
    }
    return json({ error: "not found" }, 404);
  };

  let server: Bun.Server<undefined> | undefined;
  for (let port = from; port < from + tries; port++) {
    try {
      server = Bun.serve<undefined>({
        hostname,
        port,
        async fetch(req, srv) {
          try {
            return await handle(req, srv);
          } catch (e) {
            if (e instanceof HttpError) return json({ error: e.message }, e.status);
            return json({ error: (e as Error).message || "engine error" }, 500);
          }
        },
        websocket: {
          open(ws) {
            ws.subscribe(TOPIC);
          },
          message() {},
          close(ws) {
            ws.unsubscribe(TOPIC);
          },
        },
      });
      break;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(err.message ?? "")) {
        continue;
      }
      throw e;
    }
  }
  // Bun reports a refused bind (for example in a sandbox) as EADDRINUSE too, so the message names both causes.
  if (!server) throw new Error(`No free port from ${from} to ${from + tries - 1} on ${hostname}: each one is in use or refused`);

  const live = server;
  const info: EngineInfo = { pid: process.pid, port: live.port ?? from, token };
  try {
    writeInfo(info);
  } catch (e) {
    // Without engine.json no CLI and no window can find the engine, so it must not keep the port.
    live.stop(true);
    const err = e as { code?: string; message?: string };
    throw new Error(`Cannot write ${paths.engine()}: ${err.code ?? err.message ?? String(e)}`);
  }

  return {
    info,
    url: `http://${LOOPBACK}:${info.port}`,
    publish: (event) => {
      live.publish(TOPIC, JSON.stringify(event));
    },
    clients: () => live.subscriberCount(TOPIC),
    stop: () => {
      live.stop(true);
      const now = readInfo();
      if (now && now.pid === info.pid && now.port === info.port) rmSync(paths.engine(), { force: true });
    },
  };
}
