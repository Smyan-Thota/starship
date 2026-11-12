import "./setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import type { ChatState, ChatSummary, EngineEvent } from "../../engine/src/types.ts";
import { draftKey, LiveData, type LiveDeps, type SocketLike, type StorageLike } from "../src/data.ts";
import { Live } from "../src/Live.tsx";
import { sampleChats, sampleConfig, sampleRepos, sampleState, sampleUsage } from "../src/sample.ts";

afterEach(cleanup);

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  emit(e: EngineEvent): void {
    this.onmessage?.(JSON.stringify(e));
  }
  drop(): void {
    this.closed = true;
    this.onclose?.();
  }
}

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stateFor(c: ChatSummary): ChatState {
  return { ...sampleState, chat: { ...sampleState.chat, ...c } };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** A fake engine behind a fake fetch, a fake WebSocket and a fake clock. No network. */
function harness(storage: MemoryStorage = new MemoryStorage()) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; done: boolean }[] = [];
  const calls: Call[] = [];
  const engine = {
    online: true,
    tokenOk: true,
    chats: sampleChats.slice(0, 2).map((c) => ({ ...c })),
    messages: [] as { chat: string; id: string; text: string }[],
    repos: sampleRepos.map((r) => ({ ...r })),
    config: structuredClone(sampleConfig),
    /** A refusal for one path: the status and the engine's own text. */
    refuse: {} as Record<string, { status: number; error: string }>,
  };
  let n = 0;
  const deps: LiveDeps = {
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (!engine.online) throw new TypeError("Failed to fetch");
      if (!engine.tokenOk) return json({ error: "token" }, 401);
      const path = url.split("?")[0] ?? "";
      const refused = engine.refuse[path];
      if (refused) return json({ error: refused.error }, refused.status);
      if (method === "GET" && path === "/api/chats") return json(engine.chats);
      if (method === "GET" && path === "/api/repos") return json(engine.repos);
      if (method === "GET" && path === "/api/config") return json(engine.config);
      if (method === "GET" && path === "/api/usage") return json(sampleUsage);
      if (method === "GET" && /^\/api\/repos\/[^/]+\/map$/.test(path)) return json({ map: null, errors: [] });
      if (method === "PUT" && path === "/api/config") {
        engine.config = body as typeof engine.config;
        return json({ ok: true });
      }
      if (method === "POST" && path === "/api/repos") {
        const repo = { name: String((body as { path: string }).path.split("/").at(-1)), path: (body as { path: string }).path, baseBranch: "main", hasMap: false };
        engine.repos.push(repo);
        return json(repo);
      }
      const one = path.match(/^\/api\/chats\/([^/]+)$/);
      if (method === "GET" && one) {
        const c = engine.chats.find((x) => x.id === one[1]);
        return c ? json(stateFor(c)) : json({ error: "no chat" }, 404);
      }
      if (method === "POST" && path === "/api/chats") {
        const title = (body as { title: string }).title;
        const c: ChatSummary = { id: title.toLowerCase().replace(/\s+/g, "-"), title, repo: null, stage: null, halted: null, needsYou: 0 };
        engine.chats.push(c);
        // The engine answers with the new chat's state.
        return json({ chat: c });
      }
      const msg = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
      if (method === "POST" && msg) {
        const b = body as { id: string; text: string };
        engine.messages.push({ chat: msg[1] ?? "", id: b.id, text: b.text });
        return json({ ok: true });
      }
      // Every other write on a chat or a repo: the engine says ok. The calls list holds what was sent.
      if (method === "POST" && /^\/api\/(chats|repos)\//.test(path)) return json({ ok: true });
      return json({ error: "not found" }, 404);
    },
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    storage,
    base: "",
    wsUrl: "ws://127.0.0.1:1/api/events",
    schedule: (fn, ms) => {
      const t = { fn, ms, done: false };
      timers.push(t);
      return () => {
        t.done = true;
      };
    },
    newId: () => `m${++n}`,
  };
  const live = new LiveData(deps);
  const gets = (path: string) => calls.filter((c) => c.method === "GET" && c.url === path).length;
  /** Runs the next pending timer, as if its delay passed. */
  const tick = () => {
    const t = timers.find((x) => !x.done);
    if (!t) throw new Error("no timer");
    t.done = true;
    t.fn();
    return t.ms;
  };
  const last = () => {
    const s = sockets.at(-1);
    if (!s) throw new Error("no socket");
    return s;
  };
  return { live, deps, engine, calls, sockets, timers, storage, gets, tick, last };
}

/** The connection label in the sidebar, or null when there is none. */
const conn = (root: Element) => root.querySelector(".ws .conn")?.textContent ?? null;

/** Lets pending promises settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("live data", () => {
  test("first load reads the chat list and the first chat, and opens the socket", async () => {
    const h = harness();
    expect(h.live.getSnapshot().conn).toBe("connecting");
    h.live.start();
    await flush();
    expect(h.gets("/api/chats")).toBe(1);
    expect(h.gets("/api/chats/recipe-search")).toBe(1);
    const s = h.live.getSnapshot();
    expect(s.chats.map((c) => c.id)).toEqual(["recipe-search", "login-page"]);
    expect(s.selected).toBe("recipe-search");
    expect(s.state?.chat.id).toBe("recipe-search");
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe("ws://127.0.0.1:1/api/events");
    expect(s.conn).toBe("connecting");
    h.last().open();
    await flush();
    expect(h.live.getSnapshot().conn).toBe("online");
    // The first open after a good read does not read again.
    expect(h.gets("/api/chats")).toBe(1);
    h.live.stop();
  });

  test("the open chat's line in the list takes its count, halt time and stage from the state, on a chat event", async () => {
    const h = harness();
    h.live.start();
    await flush();
    h.last().open();
    await flush();
    const before = h.gets("/api/chats");
    h.engine.chats[0] = { ...h.engine.chats[0]!, needsYou: 4, halted: "12:30" };
    h.last().emit({ type: "chat", id: "recipe-search" });
    await flush();
    const line = h.live.getSnapshot().chats.find((c) => c.id === "recipe-search");
    expect(line?.needsYou).toBe(4);
    expect(line?.halted).toBe("12:30");
    // No second read of the list was needed.
    expect(h.gets("/api/chats")).toBe(before);
    h.live.stop();
  });

  test("an event reads the named thing again", async () => {
    const h = harness();
    h.live.start();
    await flush();
    h.last().open();
    await flush();
    h.engine.chats[0] = { ...h.engine.chats[0]!, title: "Renamed" };
    h.last().emit({ type: "chats" });
    await flush();
    expect(h.gets("/api/chats")).toBe(2);
    expect(h.live.getSnapshot().chats[0]?.title).toBe("Renamed");

    h.last().emit({ type: "chat", id: "recipe-search" });
    await flush();
    expect(h.gets("/api/chats/recipe-search")).toBe(2);
    expect(h.live.getSnapshot().state?.chat.title).toBe("Renamed");

    // An event for a chat that is not open reads nothing.
    h.last().emit({ type: "chat", id: "login-page" });
    h.last().emit({ type: "usage" });
    await flush();
    expect(h.gets("/api/chats/login-page")).toBe(0);
    expect(h.gets("/api/chats")).toBe(2);
    h.live.stop();
  });

  test("I4 a dropped socket reconnects with a growing delay, then reads the chat list and the open chat again", async () => {
    const h = harness();
    h.live.start();
    await flush();
    h.last().open();
    await flush();
    const chatsBefore = h.gets("/api/chats");
    const stateBefore = h.gets("/api/chats/recipe-search");

    h.engine.online = false;
    h.last().drop();
    await flush();
    expect(h.live.getSnapshot().conn).toBe("offline");
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(h.tick());
      h.last().drop();
      await flush();
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000]);

    h.engine.online = true;
    h.engine.chats.push({ id: "new-one", title: "New one", repo: null, stage: null, halted: null, needsYou: 0 });
    h.tick();
    h.last().open();
    await flush();
    expect(h.live.getSnapshot().conn).toBe("online");
    expect(h.live.getSnapshot().chats.map((c) => c.id)).toContain("new-one");
    expect(h.gets("/api/chats")).toBeGreaterThan(chatsBefore);
    expect(h.gets("/api/chats/recipe-search")).toBe(stateBefore + 1);
    // The delay starts over after a good connection.
    h.last().drop();
    await flush();
    expect(h.tick()).toBe(500);
    h.live.stop();
  });

  test("I5 a refused token is its own state, apart from offline", async () => {
    const h = harness();
    h.engine.tokenOk = false;
    h.live.start();
    await flush();
    expect(h.live.getSnapshot().conn).toBe("unauthorized");
    expect(h.live.getSnapshot().chats).toEqual([]);

    const off = harness();
    off.engine.online = false;
    off.live.start();
    await flush();
    expect(off.live.getSnapshot().conn).toBe("offline");
    h.live.stop();
    off.live.stop();
  });

  test("createChat posts the title, and the repo and feature when there is a repo; it opens the chat and reads the list", async () => {
    const h = harness();
    h.live.start();
    await flush();
    expect(await h.live.createChat({ title: "Recipe export", repo: null, feature: "ignored" })).toBeNull();
    await flush();
    const post = h.calls.find((c) => c.method === "POST" && c.url === "/api/chats");
    expect(post?.body).toEqual({ title: "Recipe export" });
    const s = h.live.getSnapshot();
    expect(s.selected).toBe("recipe-export");
    expect(s.state?.chat.id).toBe("recipe-export");
    expect(s.chats.map((c) => c.id)).toContain("recipe-export");

    await h.live.createChat({ title: "With repo", repo: "acme", feature: "my-feature" });
    expect(h.calls.filter((c) => c.method === "POST" && c.url === "/api/chats").at(-1)?.body).toEqual({ title: "With repo", repo: "acme", feature: "my-feature" });

    // The engine's refusal comes back as its own text. The chat that was open stays open.
    h.engine.refuse["/api/chats"] = { status: 400, error: "Title taken" };
    expect(await h.live.createChat({ title: "Again", repo: null, feature: null })).toBe("Title taken");
    expect(h.live.getSnapshot().selected).toBe("with-repo");
    expect(h.live.getSnapshot().conn).not.toBe("offline");

    delete h.engine.refuse["/api/chats"];
    h.engine.online = false;
    expect(await h.live.createChat({ title: "Offline chat", repo: null, feature: null })).toBe("Offline");
    h.live.stop();
  });

  test("the first load also reads the repos, the config and the usage; each event reads its own thing again", async () => {
    const h = harness();
    h.live.start();
    await flush();
    h.last().open();
    await flush();
    const s = h.live.getSnapshot();
    expect(s.repos.map((r) => r.name)).toEqual(["acme", "starship"]);
    expect(s.config?.switch.at).toBe(90);
    expect(s.usage?.thresholdPct).toBe(90);

    h.engine.repos.push({ name: "new", path: "/x/new", baseBranch: "main", hasMap: false });
    h.engine.config.workers = 3;
    h.last().emit({ type: "repos" });
    h.last().emit({ type: "config" });
    h.last().emit({ type: "usage" });
    await flush();
    expect(h.live.getSnapshot().repos.map((r) => r.name)).toContain("new");
    expect(h.live.getSnapshot().config?.workers).toBe(3);
    expect(h.gets("/api/repos")).toBe(2);
    expect(h.gets("/api/config")).toBe(2);
    expect(h.gets("/api/usage")).toBe(2);
    h.live.stop();
  });

  test("every route has one action that sends the right request", async () => {
    const h = harness();
    h.live.start();
    await flush();
    const sent = () => h.calls.filter((c) => c.method !== "GET").at(-1);

    expect(await h.live.stage("build")).toBeNull();
    expect(sent()).toEqual({ method: "POST", url: "/api/chats/recipe-search/stage", body: { stage: "build" } });
    await h.live.halt();
    expect(sent()?.url).toBe("/api/chats/recipe-search/halt");
    await h.live.resume();
    expect(sent()?.url).toBe("/api/chats/recipe-search/resume");
    await h.live.retryMessage("m1");
    expect(sent()).toMatchObject({ method: "POST", url: "/api/chats/recipe-search/messages/m1/retry" });
    await h.live.undo(3);
    expect(sent()).toMatchObject({ method: "POST", url: "/api/chats/recipe-search/notes/3/undo" });
    await h.live.sendFixes();
    expect(sent()?.url).toBe("/api/chats/recipe-search/fixes/send");
    for (const a of ["terminal", "pause", "resume", "restart"] as const) {
      await h.live.agent("worker-a", a);
      expect(sent()).toMatchObject({ method: "POST", url: `/api/chats/recipe-search/agents/worker-a/${a}` });
    }
    await h.live.agentModel("worker-a", "codex", "gpt");
    expect(sent()).toEqual({ method: "POST", url: "/api/chats/recipe-search/agents/worker-a/model", body: { tool: "codex", model: "gpt" } });
    await h.live.openInBrowser("wireframes/search.html");
    expect(sent()?.url).toBe("/api/chats/recipe-search/open?path=wireframes%2Fsearch.html");

    expect(await h.live.addRepo("/home/o/new-repo")).toBeNull();
    expect(sent()).toEqual({ method: "POST", url: "/api/repos", body: { path: "/home/o/new-repo" } });
    await flush();
    expect(h.live.getSnapshot().repos.map((r) => r.name)).toContain("new-repo");
    await h.live.buildMap("acme");
    expect(sent()?.url).toBe("/api/repos/acme/map/build");

    await h.live.loadMap("acme", "recipe-search");
    expect(h.calls.at(-1)?.url).toBe("/api/repos/acme/map?chat=recipe-search");

    expect(await h.live.saveConfig({ ...sampleConfig, workers: 3 })).toBeNull();
    expect(sent()?.method).toBe("PUT");
    expect(sent()?.url).toBe("/api/config");
    expect((sent()?.body as { workers: number }).workers).toBe(3);
    await flush();
    expect(h.live.getSnapshot().config?.workers).toBe(3);
    await h.live.setSwitch(false);
    expect((sent()?.body as { switch: { enabled: boolean; at: number } }).switch).toMatchObject({ enabled: false, at: 90 });
    await h.live.setThreshold(75);
    expect((sent()?.body as { switch: { enabled: boolean; at: number } }).switch).toMatchObject({ at: 75 });
    h.live.stop();
  });

  test("a refusal (400 or 409) returns the engine's text, and is not offline", async () => {
    const h = harness();
    h.live.start();
    await flush();
    h.engine.refuse["/api/chats/recipe-search/stage"] = { status: 409, error: "TASKS.md has no tasks" };
    expect(await h.live.stage("build")).toBe("TASKS.md has no tasks");
    h.engine.refuse["/api/chats/recipe-search/notes/3/undo"] = { status: 409, error: "Already read" };
    expect(await h.live.undo(3)).toBe("Already read");
    h.engine.refuse["/api/chats/recipe-search/fixes/send"] = { status: 409, error: "No fixes" };
    expect(await h.live.sendFixes()).toBe("No fixes");
    h.engine.refuse["/api/config"] = { status: 400, error: "workers must be 1 to 3" };
    expect(await h.live.saveConfig({ ...sampleConfig, workers: 9 })).toBe("workers must be 1 to 3");
    h.engine.refuse["/api/repos"] = { status: 400, error: "Not a git repo" };
    expect(await h.live.addRepo("/nope")).toBe("Not a git repo");
    expect(h.live.getSnapshot().conn).not.toBe("offline");
    expect(h.live.getSnapshot().conn).not.toBe("unauthorized");

    // An unreachable engine and a refused token are their own texts.
    h.engine.online = false;
    expect(await h.live.halt()).toBe("Offline");
    expect(h.live.getSnapshot().conn).toBe("offline");
    h.engine.online = true;
    h.engine.tokenOk = false;
    expect(await h.live.halt()).toBe("Unauthorized");
    h.live.stop();
  });

  test("send posts { id, text } to the open chat and clears the draft", async () => {
    const h = harness();
    h.live.start();
    await flush();
    h.live.setDraft("Ship it");
    expect(h.storage.getItem(draftKey("recipe-search"))).toBe(JSON.stringify({ text: "Ship it" }));
    expect(await h.live.send("Ship it")).toBe(true);
    expect(h.engine.messages).toEqual([{ chat: "recipe-search", id: "m1", text: "Ship it" }]);
    expect(h.storage.getItem(draftKey("recipe-search"))).toBeNull();
    h.live.stop();
  });

  test("A14 a send while the engine cannot be reached keeps the text in the input and in the draft; send works after reconnect", async () => {
    const storage = new MemoryStorage();
    const h = harness(storage);
    const view = render(createElement(Live, { live: h.live }));
    await act(flush);
    act(() => {
      h.last().open();
    });
    await act(flush);
    const input = view.getByLabelText("Message") as HTMLInputElement;

    // The engine goes away.
    h.engine.online = false;
    act(() => {
      h.last().drop();
    });
    await act(flush);
    expect(conn(view.container)).toBe("Offline");

    fireEvent.change(input, { target: { value: "Keep the archived recipes out" } });
    fireEvent.submit(input.closest("form")!);
    await act(flush);
    expect(input.value).toBe("Keep the archived recipes out");
    expect(view.getByText("Not sent")).toBeTruthy();
    const kept = JSON.parse(storage.getItem(draftKey("recipe-search")) ?? "{}") as { text: string; id: string };
    expect(kept.text).toBe("Keep the archived recipes out");
    expect(h.engine.messages).toEqual([]);

    // A reload: the draft comes back in the input.
    view.unmount();
    h.live.stop();
    const h2 = harness(storage);
    const view2 = render(createElement(Live, { live: h2.live }));
    await act(flush);
    const input2 = view2.getByLabelText("Message") as HTMLInputElement;
    expect(input2.value).toBe("Keep the archived recipes out");

    // Offline again, then the engine comes back: send works, with the same id, and the draft is gone.
    h2.engine.online = false;
    act(() => {
      h2.last().drop();
    });
    await act(flush);
    fireEvent.submit(input2.closest("form")!);
    await act(flush);
    expect(input2.value).toBe("Keep the archived recipes out");
    h2.engine.online = true;
    act(() => {
      h2.tick();
    });
    act(() => {
      h2.last().open();
    });
    await act(flush);
    expect(conn(view2.container)).toBeNull();
    fireEvent.submit(input2.closest("form")!);
    await act(flush);
    expect(h2.engine.messages).toEqual([{ chat: "recipe-search", id: kept.id, text: "Keep the archived recipes out" }]);
    expect(input2.value).toBe("");
    expect(storage.getItem(draftKey("recipe-search"))).toBeNull();
    view2.unmount();
    h2.live.stop();
  });

  test("a storage that throws loses the draft but not the send", async () => {
    const h = harness();
    const bad: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const live = new LiveData({ ...h.deps, storage: bad });
    live.start();
    await flush();
    live.setDraft("x");
    expect(live.draft()).toBe("");
    expect(await live.send("hello")).toBe(true);
    live.stop();
  });

  test("with no engine the window renders an empty chat list and a status label; New chat opens the form", async () => {
    const h = harness();
    h.engine.online = false;
    const view = render(createElement(Live, { live: h.live }));
    await act(flush);
    expect(conn(view.container)).toBe("Offline");
    expect(view.getByText(/New chat/)).toBeTruthy();
    expect(view.container.querySelectorAll(".side .it")).toHaveLength(2);
    // The button opens the form. Create posts the title. A refusal shows as its text.
    h.engine.online = true;
    fireEvent.click(view.getByText(/New chat/));
    fireEvent.change(view.getByLabelText("Title"), { target: { value: "Recipe export" } });
    h.engine.refuse["/api/chats"] = { status: 400, error: "Title taken" };
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    await act(flush);
    expect(view.getByRole("alert").textContent).toBe("Title taken");
    delete h.engine.refuse["/api/chats"];
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    await act(flush);
    expect(h.calls.filter((c) => c.method === "POST" && c.url === "/api/chats").at(-1)?.body).toEqual({ title: "Recipe export" });
    expect(h.live.getSnapshot().selected).toBe("recipe-export");
    // The form closes and the new chat is open.
    expect(view.queryByLabelText("Title")).toBeNull();
    view.unmount();
    h.live.stop();
  });
});
