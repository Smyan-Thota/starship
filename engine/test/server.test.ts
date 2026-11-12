import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { type EngineServer, HttpError, LOOPBACK, type Route, readInfo, startServer } from "../src/server.ts";
import { drop, tempDir, tempHome } from "./helpers.ts";

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

let home: ReturnType<typeof tempHome>;
let servers: EngineServer[];
let blockers: { stop(force?: boolean): void }[];
let dirs: string[];

const routes: Route[] = [
  { method: "GET", path: "/api/ping", handler: () => ({ pong: true }) },
  { method: "POST", path: "/api/ping", handler: () => ({ posted: true }) },
  { method: "GET", path: "/api/items/:id", handler: ({ params }) => ({ id: params.id }) },
  {
    method: "GET",
    path: "/api/bad",
    handler: () => {
      throw new HttpError(400, "bad input here");
    },
  },
  {
    method: "GET",
    path: "/api/boom",
    handler: () => {
      throw new Error("kaput");
    },
  },
  { method: "POST", path: "/api/echo", handler: async ({ body }) => body() },
];

function start(extra: Partial<Parameters<typeof startServer>[0]> = {}): EngineServer {
  const s = startServer({ routes, portFrom: randomPort(), token: "t0ken", ...extra });
  servers.push(s);
  return s;
}

beforeEach(() => {
  home = tempHome();
  servers = [];
  blockers = [];
  dirs = [];
});
afterEach(() => {
  for (const s of servers) s.stop();
  for (const b of blockers) b.stop(true);
  for (const d of dirs) drop(d);
  home.restore();
});

describe("server", () => {
  test("/health answers with no token", async () => {
    const s = start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pid: process.pid });
  });

  test("I5: every other route answers 401 with no token or a wrong one", async () => {
    const s = start({ staticDir: undefined });
    for (const path of ["/api/ping", "/api/items/1", "/api/nothing", "/", "/index.html", "/api/events"]) {
      expect((await fetch(`${s.url}${path}`)).status).toBe(401);
      expect((await fetch(`${s.url}${path}`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(`${s.url}${path}?token=wrong`)).status).toBe(401);
      expect((await fetch(`${s.url}${path}`, { headers: { cookie: "starship=wrong" } })).status).toBe(401);
      expect((await fetch(`${s.url}${path}`, { headers: { authorization: "Bearer t0ke" } })).status).toBe(401);
    }
    expect((await fetch(`${s.url}/api/ping`, { method: "POST" })).status).toBe(401);
    expect(await (await fetch(`${s.url}/api/ping`)).json()).toEqual({ error: "token" });
  });

  test("I5: the right token works as a bearer header, the starship cookie, and ?token=", async () => {
    const s = start();
    const a = await fetch(`${s.url}/api/ping`, { headers: { authorization: "Bearer t0ken" } });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ pong: true });
    expect((await fetch(`${s.url}/api/ping`, { headers: { cookie: "other=1; starship=t0ken" } })).status).toBe(200);
    expect((await fetch(`${s.url}/api/ping?token=t0ken`)).status).toBe(200);
    const item = await fetch(`${s.url}/api/items/a%20b?token=t0ken`);
    expect(await item.json()).toEqual({ id: "a b" });
  });

  test("engine.json is written with mode 0600 and holds pid, port and token", () => {
    const s = start({ token: undefined });
    const file = paths.engine();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const v = JSON.parse(readFileSync(file, "utf8"));
    expect(v).toEqual({ pid: process.pid, port: s.info.port, token: s.info.token });
    expect(s.info.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readInfo()).toEqual(s.info);
  });

  test("engine.json that was readable by others becomes 0600", () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(paths.engine(), "{}", { mode: 0o644 });
    start();
    expect(statSync(paths.engine()).mode & 0o777).toBe(0o600);
  });

  test("I3: a taken port moves to the next free one, and engine.json has the real port", async () => {
    const taken = randomPort();
    blockers.push(Bun.serve({ hostname: LOOPBACK, port: taken, fetch: () => new Response("other") }));
    const s = start({ portFrom: taken });
    expect(s.info.port).toBeGreaterThan(taken);
    expect(readInfo()?.port).toBe(s.info.port);
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
    expect(await (await fetch(`http://${LOOPBACK}:${taken}/health`)).text()).toBe("other");
  });

  test("I3: when every port in the range is taken, start fails and names the range", () => {
    const taken = randomPort();
    blockers.push(Bun.serve({ hostname: LOOPBACK, port: taken, fetch: () => new Response("other") }));
    expect(() => start({ portFrom: taken, tries: 1 })).toThrow(/No free port/);
    expect(existsSync(paths.engine())).toBe(false);
  });

  test("loopback: startServer refuses any address except 127.0.0.1", () => {
    for (const hostname of ["0.0.0.0", "::", "localhost", "192.168.1.2", "::1"]) {
      expect(() => start({ hostname })).toThrow(/127\.0\.0\.1 only/);
    }
    expect(existsSync(paths.engine())).toBe(false);
    const s = start({ hostname: "127.0.0.1" });
    expect(s.url).toStartWith("http://127.0.0.1:");
  });

  test("a request with a foreign Host header is refused 403, also on /health", async () => {
    const s = start();
    for (const path of ["/health", "/api/ping?token=t0ken"]) {
      const res = await fetch(`${s.url}${path}`, { headers: { host: "evil.example:80" } });
      expect(res.status).toBe(403);
    }
    expect((await fetch(`${s.url}/api/ping?token=t0ken`, { headers: { host: `localhost:${s.info.port}` } })).status).toBe(200);
    expect((await fetch(`${s.url}/api/ping?token=t0ken`, { headers: { host: `127.0.0.1:${s.info.port + 1}` } })).status).toBe(403);
  });

  test("a POST with a foreign Origin is refused 403; our own origin and no origin pass", async () => {
    const s = start();
    const post = (origin?: string) => fetch(`${s.url}/api/ping?token=t0ken`, { method: "POST", headers: origin ? { origin } : {} });
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("null")).status).toBe(403);
    expect((await post(`http://localhost:${s.info.port + 1}`)).status).toBe(403);
    expect((await post(s.url)).status).toBe(200);
    expect((await post(`http://localhost:${s.info.port}`)).status).toBe(200);
    expect((await post("tauri://localhost")).status).toBe(200);
    expect((await post()).status).toBe(200);
  });

  test("a route that throws HttpError(400) gives 400 and a JSON error; another error gives 500", async () => {
    const s = start();
    const bad = await fetch(`${s.url}/api/bad?token=t0ken`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("application/json");
    expect(await bad.json()).toEqual({ error: "bad input here" });
    const boom = await fetch(`${s.url}/api/boom?token=t0ken`);
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "kaput" });
  });

  test("a body that is not JSON gives 400", async () => {
    const s = start();
    const res = await fetch(`${s.url}/api/echo?token=t0ken`, { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the request body must be JSON" });
  });

  test("an unknown /api path gives 404, also with a static folder", async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<p>page</p>");
    const s = start({ staticDir: dir });
    for (const path of ["/api/nothing", "/api/items", "/api/items/1/2", "/api/"]) {
      const res = await fetch(`${s.url}${path}?token=t0ken`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
    expect((await fetch(`${s.url}/api/ping?token=t0ken`, { method: "PUT" })).status).toBe(404);
  });

  test("the WebSocket at /api/events needs the token, and publish() reaches a connected client", async () => {
    const s = start();
    const ws = `ws://${LOOPBACK}:${s.info.port}/api/events`;

    const refused = await new Promise<string>((resolve) => {
      const c = new WebSocket(ws);
      c.onopen = () => {
        c.close();
        resolve("open");
      };
      c.onerror = () => resolve("error");
    });
    expect(refused).toBe("error");
    expect((await fetch(`${s.url}/api/events?token=t0ken`)).status).toBe(400);

    const client = new WebSocket(`${ws}?token=t0ken`);
    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve();
      client.onerror = () => reject(new Error("no connection"));
    });
    for (let i = 0; i < 50 && s.clients() < 1; i++) await Bun.sleep(10);
    expect(s.clients()).toBe(1);
    const got = new Promise<string>((resolve) => {
      client.onmessage = (m) => resolve(String(m.data));
    });
    s.publish({ type: "chat", id: "demo" });
    expect(JSON.parse(await got)).toEqual({ type: "chat", id: "demo" });
    client.close();
    for (let i = 0; i < 50 && s.clients() > 0; i++) await Bun.sleep(10);
    expect(s.clients()).toBe(0);
  });

  test("the WebSocket refuses a foreign Origin even with the token", async () => {
    const s = start();
    const res = await fetch(`${s.url}/api/events?token=t0ken`, {
      headers: { origin: "https://evil.example", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    expect(res.status).toBe(403);
  });

  test("stop() removes engine.json and the port closes", async () => {
    const s = startServer({ routes, portFrom: randomPort(), token: "t0ken" });
    expect(existsSync(paths.engine())).toBe(true);
    s.stop();
    expect(existsSync(paths.engine())).toBe(false);
    await expect(fetch(`${s.url}/health`)).rejects.toThrow();
  });

  test("stop() leaves an engine.json that another engine wrote", () => {
    const s = startServer({ routes, portFrom: randomPort(), token: "t0ken" });
    writeFileSync(paths.engine(), JSON.stringify({ pid: 999999, port: 1, token: "x" }));
    s.stop();
    expect(readInfo()).toEqual({ pid: 999999, port: 1, token: "x" });
  });

  describe("static files", () => {
    let dir: string;
    let outside: string;
    beforeEach(() => {
      outside = tempDir();
      dirs.push(outside);
      dir = join(outside, "dist");
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "index.html"), "<p>index</p>");
      writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
      writeFileSync(join(outside, "secret.txt"), "secret");
    });

    test("serves a file from staticDir with its type, and index.html as the fallback", async () => {
      const s = start({ staticDir: dir });
      const js = await fetch(`${s.url}/assets/app.js?token=t0ken`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      expect(await js.text()).toBe("console.log(1)");
      for (const path of ["/", "/chats/demo", "/assets", "/missing.png"]) {
        const res = await fetch(`${s.url}${path}?token=t0ken`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("<p>index</p>");
      }
    });

    test("never serves a file from outside staticDir", async () => {
      const s = start({ staticDir: dir });
      for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e%2fsecret.txt"]) {
        const res = await fetch(`${s.url}${path}`, { headers: { authorization: "Bearer t0ken" } });
        expect(await res.text()).not.toContain("secret");
      }
      const bad = await fetch(`${s.url}/%E0%A4%A?token=t0ken`);
      expect(await bad.text()).not.toContain("secret");
    });

    test("a page load with ?token= sets the cookie, and the cookie then works", async () => {
      const s = start({ staticDir: dir });
      const res = await fetch(`${s.url}/?token=t0ken`);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("starship=t0ken");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const again = await fetch(`${s.url}/assets/app.js`, { headers: { cookie: cookie.split(";")[0] ?? "" } });
      expect(again.status).toBe(200);
      const plain = await fetch(`${s.url}/`, { headers: { authorization: "Bearer t0ken" } });
      expect(plain.headers.get("set-cookie")).toBeNull();
    });

    test("I5: a stale cookie from an older engine does not block a good ?token=, and the page load replaces the cookie", async () => {
      const s = start({ staticDir: dir });
      const stale = { cookie: "starship=token-of-an-older-engine" };
      expect((await fetch(`${s.url}/api/ping`, { headers: stale })).status).toBe(401);
      expect((await fetch(`${s.url}/api/ping?token=t0ken`, { headers: stale })).status).toBe(200);
      const page = await fetch(`${s.url}/?token=t0ken`, { headers: stale });
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie") ?? "").toContain("starship=t0ken");
      // A wrong token in the address is still refused, even next to a good cookie's absence.
      expect((await fetch(`${s.url}/?token=wrong`, { headers: stale })).status).toBe(401);
    });

    test("with no index.html, an unknown path is 404", async () => {
      const empty = tempDir();
      dirs.push(empty);
      const s = start({ staticDir: empty });
      expect((await fetch(`${s.url}/x?token=t0ken`)).status).toBe(404);
    });
  });
});
