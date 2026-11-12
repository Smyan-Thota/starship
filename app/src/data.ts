/**
 * The window's live data: the chat list and the open chat's state, read from the engine.
 *
 * - Reads over HTTP. The page was loaded with ?token=, so the engine's cookie authenticates every same-origin call.
 * - Listens on the WebSocket at /api/events. Each event names what to read again.
 * - When the socket drops, it reconnects with a growing delay (0.5 s up to 5 s), then reads the chat list and the
 *   open chat again (edge I4).
 * - A message being sent is also a draft in localStorage, one key per chat. It stays there until the engine
 *   accepts it, so an offline engine or a reload never loses it (edge A14).
 * - A 401 is its own state, apart from offline (edge I5).
 *
 * - Every action returns null when the engine did it, or the text to show. A refusal (400, 409) returns the engine's
 *   own `error` text. Only an unreachable engine or a refused token read as "Offline" and "Unauthorized".
 *
 * The class has no React in it. `useLive` connects it to a component.
 */
import { useSyncExternalStore } from "react";
import type { ChatState, ChatSummary, EngineEvent, FileBody, MapFile, RepoInfo, Stage, Tool, UsageState } from "../../engine/src/types.ts";
import type { SettingsConfig } from "./pages/Settings.tsx";

export type Conn = "connecting" | "online" | "reconnecting" | "offline" | "unauthorized";

/** The status label in the window. null when all is well. */
export const CONN_LABEL: Record<Conn, string | null> = {
  connecting: "Connecting",
  online: null,
  reconnecting: "Reconnecting",
  offline: "Offline",
  unauthorized: "Unauthorized",
};

export interface LiveSnapshot {
  conn: Conn;
  chats: ChatSummary[];
  /** The open chat's id. */
  selected: string | null;
  /** The open chat's state, once read. */
  state: ChatState | null;
  repos: RepoInfo[];
  /** null until read. */
  config: SettingsConfig | null;
  /** null until read. */
  usage: UsageState | null;
}

/** GET /api/repos/:name/map */
export interface MapAnswer {
  map: MapFile | null;
  errors: string[];
}

export interface NewChatInput {
  title: string;
  repo: string | null;
  feature: string | null;
}

export type AgentAction = "terminal" | "pause" | "resume" | "restart";

/** The part of a WebSocket the data layer uses. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The part of localStorage the data layer uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LiveDeps {
  fetch: FetchLike;
  socket: (url: string) => SocketLike;
  /** null when the browser gives none. */
  storage: StorageLike | null;
  /** Prefix for every HTTP path. "" for the page's own origin. */
  base: string;
  /** The WebSocket address of /api/events. */
  wsUrl: string;
  /** Runs fn after ms. Returns a cancel function. Tests pass a fake clock. */
  schedule: (fn: () => void, ms: number) => () => void;
  newId: () => string;
}

export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 5000;

export const draftKey = (chat: string) => `starship.draft.${chat}`;
const SELECTED_KEY = "starship.chat";

interface Draft {
  text: string;
  /** Set once a send was tried, so a resend of the same text reuses the id and the engine can drop the copy. */
  id?: string;
}

/** The engine cannot be reached. */
export class Offline extends Error {
  constructor() {
    super("offline");
    this.name = "Offline";
  }
}

/** The engine refused the token. */
export class Unauthorized extends Error {
  constructor() {
    super("unauthorized");
    this.name = "Unauthorized";
  }
}

/** Any other answer that is not 2xx. */
export class HttpFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpFailure";
  }
}

export class LiveData {
  private snap: LiveSnapshot = { conn: "connecting", chats: [], selected: null, state: null, repos: [], config: null, usage: null };
  private listeners = new Set<() => void>();
  private ws: SocketLike | null = null;
  private wsOpen = false;
  private everOpen = false;
  private lastFetch: "none" | "ok" | "offline" | "unauthorized" = "none";
  private attempt = 0;
  private cancelRetry: (() => void) | null = null;
  private running = false;
  /** Sequence numbers, so an old answer never overwrites a newer one. */
  private chatsSeq = 0;
  private stateSeq = 0;
  private reposSeq = 0;
  private configSeq = 0;
  private usageSeq = 0;

  constructor(private deps: LiveDeps) {
    this.snap = { ...this.snap, selected: this.store("get", SELECTED_KEY) };
  }

  // ---- React glue ------------------------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): LiveSnapshot => this.snap;

  private set(patch: Partial<LiveSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  private updateConn(): void {
    let conn: Conn;
    if (this.lastFetch === "unauthorized") conn = "unauthorized";
    else if (this.lastFetch === "offline") conn = "offline";
    else if (!this.wsOpen) conn = this.everOpen ? "reconnecting" : "connecting";
    else conn = "online";
    if (conn !== this.snap.conn) this.set({ conn });
  }

  // ---- storage ---------------------------------------------------------------------------------------------

  private store(op: "get", key: string): string | null;
  private store(op: "set", key: string, value: string): void;
  private store(op: "remove", key: string): void;
  private store(op: "get" | "set" | "remove", key: string, value?: string): string | null | void {
    const s = this.deps.storage;
    if (!s) return op === "get" ? null : undefined;
    try {
      if (op === "get") return s.getItem(key);
      if (op === "set") s.setItem(key, value ?? "");
      else s.removeItem(key);
    } catch {
      // Private mode or a full disk: the draft lives only in the input.
    }
    return op === "get" ? null : undefined;
  }

  private readDraft(chat: string): Draft | null {
    const raw = this.store("get", draftKey(chat));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<Draft>;
      if (typeof v.text !== "string") return null;
      return typeof v.id === "string" ? { text: v.text, id: v.id } : { text: v.text };
    } catch {
      return null;
    }
  }

  /** The draft of a chat: the text that was typed and not yet accepted by the engine. */
  draft(chat: string | null = this.snap.selected): string {
    return chat ? (this.readDraft(chat)?.text ?? "") : "";
  }

  /** Keeps what is in the input of the open chat. */
  setDraft(text: string): void {
    const chat = this.snap.selected;
    if (!chat) return;
    if (!text) {
      this.store("remove", draftKey(chat));
      return;
    }
    const prev = this.readDraft(chat);
    const next: Draft = prev?.id && prev.text === text ? { text, id: prev.id } : { text };
    this.store("set", draftKey(chat), JSON.stringify(next));
  }

  // ---- HTTP ------------------------------------------------------------------------------------------------

  private async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.deps.fetch(this.deps.base + path, {
        method,
        credentials: "same-origin",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch {
      this.lastFetch = "offline";
      this.updateConn();
      throw new Offline();
    }
    if (res.status === 401) {
      this.lastFetch = "unauthorized";
      this.updateConn();
      throw new Unauthorized();
    }
    this.lastFetch = "ok";
    this.updateConn();
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const b = (await res.json()) as { error?: unknown };
        if (typeof b.error === "string") message = b.error;
      } catch {
        // not JSON
      }
      throw new HttpFailure(res.status, message);
    }
    // A 200 may carry no body.
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
  }

  /** Reads the chat list. Picks a chat when none is open or the open one is gone. */
  async loadChats(): Promise<void> {
    const seq = ++this.chatsSeq;
    let chats: ChatSummary[];
    try {
      chats = await this.request<ChatSummary[]>("GET", "/api/chats");
    } catch {
      return;
    }
    if (seq !== this.chatsSeq) return;
    const sel = this.snap.selected;
    const keep = sel && chats.some((c) => c.id === sel) ? sel : (chats[0]?.id ?? null);
    const changed = keep !== sel;
    this.set({ chats, selected: keep, ...(changed ? { state: null } : {}) });
    if (changed) {
      if (keep) this.store("set", SELECTED_KEY, keep);
      await this.loadState();
    }
  }

  /** Reads the open chat's state. */
  async loadState(): Promise<void> {
    const id = this.snap.selected;
    const seq = ++this.stateSeq;
    if (!id) {
      this.set({ state: null });
      return;
    }
    try {
      const state = await this.request<ChatState>("GET", `/api/chats/${encodeURIComponent(id)}`);
      if (seq === this.stateSeq && this.snap.selected === id) {
        // The engine announces a change of one chat as a "chat" event, and the list only as "chats". The open chat's
        // line in the list takes its count, halt time and stage from the state just read, so the two never disagree.
        const { needsYou, halted, stage } = state.chat;
        const chats = this.snap.chats.map((c) => (c.id === id && (c.needsYou !== needsYou || c.halted !== halted || c.stage !== stage) ? { ...c, needsYou, halted, stage } : c));
        this.set({ state, chats });
      }
    } catch (e) {
      // A chat that went away: the list is read again and another chat opens.
      if (e instanceof HttpFailure && e.status === 404 && seq === this.stateSeq) await this.loadChats();
    }
  }

  /** Reads the repos. */
  async loadRepos(): Promise<void> {
    const seq = ++this.reposSeq;
    try {
      const repos = await this.request<RepoInfo[]>("GET", "/api/repos");
      if (seq === this.reposSeq && Array.isArray(repos)) this.set({ repos });
    } catch {
      // Offline or refused: updateConn shows it.
    }
  }

  /** Reads the config. */
  async loadConfig(): Promise<void> {
    const seq = ++this.configSeq;
    try {
      const config = await this.request<SettingsConfig>("GET", "/api/config");
      if (seq === this.configSeq && config) this.set({ config });
    } catch {
      // As above.
    }
  }

  /** Reads the usage. */
  async loadUsage(): Promise<void> {
    const seq = ++this.usageSeq;
    try {
      const usage = await this.request<UsageState>("GET", "/api/usage");
      if (seq === this.usageSeq && usage) this.set({ usage });
    } catch {
      // As above.
    }
  }

  /** Reads everything: the chat list, the open chat, the repos, the config and the usage. */
  async load(): Promise<void> {
    void this.loadRepos();
    void this.loadConfig();
    void this.loadUsage();
    const before = this.snap.selected;
    await this.loadChats();
    // loadChats already read the state when it changed the open chat.
    if (this.snap.selected && this.snap.selected === before) await this.loadState();
  }

  // ---- WebSocket -------------------------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.load();
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.cancelRetry?.();
    this.cancelRetry = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    }
  }

  /** The delay before the next reconnect: 0.5 s, 1 s, 2 s, 4 s, then 5 s. */
  static delay(attempt: number): number {
    return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
  }

  private connect(): void {
    if (!this.running) return;
    let ws: SocketLike;
    try {
      ws = this.deps.socket(this.deps.wsUrl);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsOpen = true;
      const again = this.everOpen;
      this.everOpen = true;
      this.attempt = 0;
      this.updateConn();
      // The first open follows the first read in start(). Every later open reads everything again (edge I4).
      if (again || this.lastFetch !== "ok") void this.load();
    };
    ws.onmessage = (data) => {
      if (this.ws !== ws) return;
      this.onEvent(data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsOpen = false;
      this.updateConn();
      // A read tells offline from a refused token.
      void this.loadChats();
      this.retry();
    };
  }

  private retry(): void {
    if (!this.running) return;
    const ms = LiveData.delay(this.attempt);
    this.attempt++;
    this.cancelRetry?.();
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = null;
      this.connect();
    }, ms);
  }

  private onEvent(data: string): void {
    let e: EngineEvent;
    try {
      e = JSON.parse(data) as EngineEvent;
    } catch {
      return;
    }
    if (e.type === "chats") void this.loadChats();
    else if (e.type === "chat" && e.id === this.snap.selected) void this.loadState();
    else if (e.type === "repos") void this.loadRepos();
    else if (e.type === "config") void this.loadConfig();
    else if (e.type === "usage") void this.loadUsage();
  }

  // ---- actions ---------------------------------------------------------------------------------------------

  select(id: string): void {
    if (id === this.snap.selected) return;
    this.store("set", SELECTED_KEY, id);
    this.set({ selected: id, state: null });
    void this.loadState();
  }

  /** The text to show when an action did not work. */
  private refusal(e: unknown): string {
    if (e instanceof HttpFailure) return e.message;
    if (e instanceof Unauthorized) return "Unauthorized";
    if (e instanceof Offline) return "Offline";
    return "Failed";
  }

  /** Runs one write. null: the engine did it. A string: the text to show. */
  private async act(method: "POST" | "PUT", path: string, body?: unknown): Promise<string | null> {
    try {
      await this.request<unknown>(method, path, body);
      return null;
    } catch (e) {
      return this.refusal(e);
    }
  }

  /** One write on the open chat. The chat is read again when it worked. */
  private async chatAct(suffix: string, body?: unknown): Promise<string | null> {
    const chat = this.snap.selected;
    if (!chat) return "No chat";
    const err = await this.act("POST", `/api/chats/${encodeURIComponent(chat)}${suffix}`, body);
    if (err === null && this.snap.selected === chat) void this.loadState();
    return err;
  }

  /** Makes a chat and opens it. Returns null when it is made, or the engine's refusal. */
  async createChat(input: NewChatInput): Promise<string | null> {
    const body: Record<string, string> = { title: input.title };
    if (input.repo) {
      body.repo = input.repo;
      if (input.feature) body.feature = input.feature;
    }
    let id: string | undefined;
    try {
      // The engine answers with the new chat's state, so its id is at chat.id.
      id = (await this.request<{ chat?: { id?: string } }>("POST", "/api/chats", body))?.chat?.id;
    } catch (e) {
      return this.refusal(e);
    }
    if (!id) return "Failed";
    this.store("set", SELECTED_KEY, id);
    ++this.stateSeq;
    this.set({ selected: id, state: null });
    await Promise.all([this.loadChats(), this.loadState()]);
    return null;
  }

  /** Adds a repo. Returns null when it is added, or the engine's refusal. */
  async addRepo(path: string): Promise<string | null> {
    const err = await this.act("POST", "/api/repos", { path });
    if (err === null) void this.loadRepos();
    return err;
  }

  /** The map of a repo, with the overlay of one chat. Rejects when the engine cannot be reached. */
  loadMap(repo: string, chat: string): Promise<MapAnswer> {
    return this.request<MapAnswer>("GET", `/api/repos/${encodeURIComponent(repo)}/map?chat=${encodeURIComponent(chat)}`);
  }

  async buildMap(repo: string): Promise<string | null> {
    const err = await this.act("POST", `/api/repos/${encodeURIComponent(repo)}/map/build`);
    if (err === null) void this.loadRepos();
    return err;
  }

  async saveConfig(config: SettingsConfig): Promise<string | null> {
    const err = await this.act("PUT", "/api/config", config);
    if (err === null) void this.loadConfig();
    return err;
  }

  /** Switches the move of workers between tools on or off. */
  setSwitch(enabled: boolean): Promise<string | null> {
    const c = this.snap.config;
    return c ? this.saveConfig({ ...c, switch: { ...c.switch, enabled } }) : Promise.resolve("Failed");
  }

  /** Sets the usage threshold. */
  setThreshold(at: number): Promise<string | null> {
    const c = this.snap.config;
    return c ? this.saveConfig({ ...c, switch: { ...c.switch, at } }) : Promise.resolve("Failed");
  }

  /**
   * Sends a message to the open chat's admin agent. The text is a draft until the engine accepts it.
   * Returns true when the engine accepted it. On false the caller keeps the text in the input.
   */
  async send(text: string): Promise<boolean> {
    const chat = this.snap.selected;
    if (!chat || !text.trim()) return false;
    const prev = this.readDraft(chat);
    const id = prev?.id && prev.text === text ? prev.id : this.deps.newId();
    this.store("set", draftKey(chat), JSON.stringify({ text, id } satisfies Draft));
    try {
      await this.request<unknown>("POST", `/api/chats/${encodeURIComponent(chat)}/messages`, { id, text });
    } catch {
      return false;
    }
    if (this.readDraft(chat)?.id === id) this.store("remove", draftKey(chat));
    if (this.snap.selected === chat) void this.loadState();
    return true;
  }

  /** One file of the open chat. */
  loadFile(path: string): Promise<FileBody> {
    const chat = this.snap.selected;
    if (!chat) return Promise.reject(new Error("No chat"));
    return this.request<FileBody>("GET", `/api/chats/${encodeURIComponent(chat)}/file?path=${encodeURIComponent(path)}`);
  }

  /** One file of the chat's worktree, read-only text. The engine reads it through GET /api/chats/:id/code. */
  loadCode(path: string): Promise<FileBody> {
    const chat = this.snap.selected;
    if (!chat) return Promise.reject(new Error("No chat"));
    return this.request<FileBody>("GET", `/api/chats/${encodeURIComponent(chat)}/code?path=${encodeURIComponent(path)}`);
  }

  openInBrowser(path: string): Promise<string | null> {
    return this.chatAct(`/open?path=${encodeURIComponent(path)}`);
  }

  halt(): Promise<string | null> {
    return this.chatAct("/halt");
  }

  resume(): Promise<string | null> {
    return this.chatAct("/resume");
  }

  /** Asks the engine to move the chat to a stage. A refusal comes back as its text. */
  stage(stage: Stage): Promise<string | null> {
    return this.chatAct("/stage", { stage });
  }

  retryMessage(messageId: string): Promise<string | null> {
    return this.chatAct(`/messages/${encodeURIComponent(messageId)}/retry`);
  }

  /** Takes a note back. The refusal is "Being read" or "Already read". */
  undo(note: number): Promise<string | null> {
    return this.chatAct(`/notes/${note}/undo`);
  }

  sendFixes(): Promise<string | null> {
    return this.chatAct("/fixes/send");
  }

  agent(id: string, action: AgentAction): Promise<string | null> {
    return this.chatAct(`/agents/${encodeURIComponent(id)}/${action}`);
  }

  agentModel(id: string, tool: Tool, model: string): Promise<string | null> {
    return this.chatAct(`/agents/${encodeURIComponent(id)}/model`, { tool, model });
  }
}

/** A real browser WebSocket, behind SocketLike. */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const s: SocketLike = { onopen: null, onmessage: null, onclose: null, close: () => ws.close() };
  ws.onopen = () => s.onopen?.();
  ws.onmessage = (e: MessageEvent) => s.onmessage?.(typeof e.data === "string" ? e.data : String(e.data));
  ws.onclose = () => s.onclose?.();
  return s;
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The data layer for the page the engine serves. */
export function browserDeps(): LiveDeps {
  const { protocol, host } = window.location;
  return {
    fetch: (url, init) => window.fetch(url, init),
    socket: browserSocket,
    storage: browserStorage(),
    base: "",
    wsUrl: `${protocol === "https:" ? "wss" : "ws"}://${host}/api/events`,
    schedule: (fn, ms) => {
      const t = window.setTimeout(fn, ms);
      return () => window.clearTimeout(t);
    },
    newId: () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  };
}

export function useLive(live: LiveData): LiveSnapshot {
  return useSyncExternalStore(live.subscribe, live.getSnapshot);
}
