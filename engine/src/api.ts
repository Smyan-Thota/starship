/**
 * The HTTP API: chats and their state, files, repos and maps, config, and the writes of the agents and the
 * owner (notes, questions, findings, cards, wireframe links). The task loop is connected through the optional
 * callbacks of `ApiDeps`; each one runs after its write.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Engine, Refused } from "./engine.ts";
import { ChatError, type StateExtra, chatState, chatSummary, createChat, getChat, listChats, planProblems } from "./chats.ts";
import { ConfigError, loadConfig, parseConfig, paths, saveConfig } from "./config.ts";
import { FindingError, addFinding, decideFinding, disputeFinding, markNoFindings, readFindings } from "./folder/findings.ts";
import { FolderMissing, PathRefused, listFiles, readFileSafe } from "./folder/folder.ts";
import { type Note, NoteError, type NoteTarget, appendNote, markRead, parseNotes, undo as undoNote } from "./folder/notes.ts";
import { type Question, QuestionError, answerQuestion, appendQuestion, parseQuestions } from "./folder/questions.ts";
import { writeRunFile } from "./folder/write.ts";
import { MapImportError, buildLowDetailMap, importMap } from "./map/build.ts";
import { applyOverlay, overlayShape, readOverlay } from "./map/overlay.ts";
import { readMapFile } from "./map/schema.ts";
import type { TaskCommand } from "./run/orchestrator.ts";
import { OpenRefused, type Runner, fileBody, openFolderFile, openTarget, spawnRunner } from "./open.ts";
import { RepoError, addRepo, getRepo, listRepos, mapFile, repoInfo, saveMap } from "./repos.ts";
import { CardError, type CardResult, recordCardResult } from "./review/cards.ts";
import { FixesError, fixList, readFixes, writeFixes } from "./review/fixes.ts";
import { type Handler, HttpError, type Route, json } from "./server.ts";
import { type OpenTerminalOptions, type TerminalApp, openTerminal } from "./terminal.ts";
import { hhmm, stamp } from "./time.ts";
import type { ChatSummary, EngineEvent, Stage } from "./types.ts";
import { setWireframeLink } from "./wireframes.ts";

export interface ApiDeps {
  publish(event: EngineEvent): void;
  /** Runs `open`. Tests pass a fake. */
  run?: Runner;
  /** Plan files changed by hand, per chat id. */
  handEdits?: (id: string) => string[];
  /** A note was written to run/handoffs.md. */
  onNote?(chatId: string, note: Note): void;
  /** A question was added to run/questions.md. */
  onQuestion?(chatId: string, question: Question): void;
  /** A question was answered. */
  onAnswer?(chatId: string, question: Question): void;
  /** A finding was added, disputed, accepted or rejected. */
  onFinding?(chatId: string): void;
  /**
   * The engine's parts. With it, the routes that need the running loop exist, a note to the orchestrator is delivered,
   * a question parks its task, an answer goes to the worker, and the chat state shows the live agents.
   */
  engine?: Engine;
  /** Opens a terminal window. Tests pass a fake, so no window opens. */
  terminal?: (session: string, o: OpenTerminalOptions) => { app: TerminalApp };
}

/** Maps library errors to HTTP statuses. */
export function toHttp(e: unknown): unknown {
  if (e instanceof HttpError) return e;
  if (e instanceof Refused) return new HttpError(e.status, e.message);
  if (e instanceof ChatError) return new HttpError(e.status, e.message);
  if (e instanceof RepoError) return new HttpError(e.notFound ? 404 : 400, e.message);
  if (e instanceof PathRefused || e instanceof OpenRefused) return new HttpError(400, e.message);
  if (e instanceof FolderMissing) return new HttpError(409, e.message);
  if (e instanceof NoteError || e instanceof QuestionError || e instanceof FindingError || e instanceof CardError || e instanceof FixesError) return new HttpError(missing(e.message) ? 404 : 400, e.message);
  return e;
}

/** The libraries word "nothing by that number" as "no finding 3", "no card C2", "no question Q4". */
const missing = (message: string) => /^no (note|question|finding|card|wireframe)\b/.test(message);

async function objectBody(body: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const b = await body();
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new HttpError(400, "the request body must be a JSON object");
  return b as Record<string, unknown>;
}

function guard(h: Handler): Handler {
  return async (ctx) => {
    try {
      return await h(ctx);
    } catch (e) {
      // A refusal that carries more than a message, such as the plan's problems, answers with all of it.
      if (e instanceof Refused && Object.keys(e.extra).length > 0) return json({ error: e.message, ...e.extra }, e.status);
      throw toHttp(e);
    }
  };
}

function text(v: unknown, what: string, required: boolean): string | undefined {
  if (v === undefined || v === null || (v === "" && !required)) {
    if (required) throw new HttpError(400, `"${what}" is required`);
    return undefined;
  }
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `"${what}" must be text`);
  return v;
}

/** The feature folder of a chat. A chat with no folder is 404; a folder that is gone is 409. */
function folderOf(id: string): string {
  const chat = getChat(id);
  if (!chat.featureDir) throw new HttpError(404, `chat "${id}" has no feature folder`);
  if (!existsSync(chat.featureDir) || !statSync(chat.featureDir).isDirectory()) throw new FolderMissing(chat.featureDir);
  return chat.featureDir;
}

const TARGETS: readonly NoteTarget[] = ["orchestrator", "plan", "fixes", "repo"];

/** "Q3" or "3" gives 3; "F3" or "3" gives 3. */
function numberOf(v: string, prefix: string, what: string): number {
  const m = v.match(new RegExp(`^${prefix}?(\\d+)$`, "i"));
  if (!m) throw new HttpError(400, `"${v}" is not a ${what} number`);
  return Number(m[1]);
}

/** The fix list follows the findings and the notes to `fixes`. Each fix keeps its number. */
export function rebuildFixes(dir: string): void {
  const notesFile = join(dir, "run", "handoffs.md");
  const notes = parseNotes(existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "").notes;
  writeFixes(dir, fixList(readFindings(dir).findings, notes, readFixes(dir).fixes));
}

function summaries(extra: (id: string) => StateExtra): ChatSummary[] {
  const out: ChatSummary[] = [];
  for (const c of listChats()) {
    try {
      out.push(chatSummary(c.id, extra(c.id)));
    } catch {
      out.push({ id: c.id, title: c.title, repo: c.repo, stage: c.stage, halted: c.halted, needsYou: 0 });
    }
  }
  return out;
}

/** The notes the engine stopped delivering. A chat with no feature folder has none. */
function stuckNotes(engine: Engine, id: string): number[] {
  try {
    return engine.notes.needsYou(id).map((n) => n.n);
  } catch {
    return [];
  }
}

export function routes(deps: ApiDeps): Route[] {
  const run = deps.run ?? spawnRunner;
  // Route.method names GET and POST only. The server compares the method as text, so PUT works at run time.
  const r = (method: Route["method"], path: string, handler: Handler): Route => ({ method, path, handler: guard(handler) });
  const changed = (id: string) => deps.publish({ type: "chat", id });
  const engine = deps.engine;
  /** What the engine adds to a chat's state: the live agents and the checks in the queue. */
  const live = (id: string): StateExtra => (engine ? { agents: engine.agentViews(id), queue: engine.queueItems(id), stuckNotes: stuckNotes(engine, id) } : {});
  const fail = (what: string) => (e: unknown) => console.error(`api: ${what}: ${e instanceof Error ? e.message : String(e)}`);
  // The part that comes after a write must not fail the request: the write is on disk already.
  const noteWritten = (id: string, n: Note) => {
    deps.onNote?.(id, n);
    if (engine && n.to === "orchestrator") engine.notes.recorded(id, n.n).catch(fail(`delivering note ${n.n}`));
  };
  const questionAsked = (id: string, q: Question) => {
    deps.onQuestion?.(id, q);
    try {
      engine?.questions.asked(id, { n: q.n, task: q.task, agent: q.agent, text: q.question });
    } catch (e) {
      fail(`parking for Q${q.n}`)(e);
    }
  };
  const questionAnswered = (id: string, q: Question) => {
    deps.onAnswer?.(id, q);
    engine?.questions.answered(id, { n: q.n, task: q.task, text: q.answer ?? "" }).catch(fail(`sending the answer to Q${q.n}`));
  };
  return [
    r("GET", "/api/chats", () => summaries(live)),
    r("GET", "/api/chats/:id", ({ params }) => {
      const id = params.id ?? "";
      return chatState(id, { ...live(id), handEdits: deps.handEdits?.(id) ?? [] });
    }),
    r("POST", "/api/chats", async ({ body }) => {
      const b = await objectBody(body);
      const title = text(b.title, "title", true) ?? "";
      const repo = text(b.repo, "repo", false);
      const folder = text(b.folder, "folder", false);
      const feature = text(b.feature, "feature", false);
      const chat = createChat({ title, ...(repo ? { repo } : {}), ...(folder ? { folder } : {}), ...(feature ? { feature } : {}) });
      deps.publish({ type: "chats" });
      return chatState(chat.id, live(chat.id));
    }),
    r("GET", "/api/chats/:id/files", ({ params }) => {
      const chat = getChat(params.id ?? "");
      if (!chat.featureDir) return [];
      return listFiles(folderOf(chat.id));
    }),
    r("GET", "/api/chats/:id/file", ({ params, url }) => {
      const dir = folderOf(params.id ?? "");
      const path = text(url.searchParams.get("path") ?? undefined, "path", true) ?? "";
      return fileBody(dir, path);
    }),
    r("POST", "/api/chats/:id/open", ({ params, url }) => {
      const id = params.id ?? "";
      const path = url.searchParams.get("path");
      const wireframe = url.searchParams.get("wireframe");
      if (wireframe) {
        const state = chatState(id);
        if (state.folderMissing && state.chat.featureDir) throw new FolderMissing(state.chat.featureDir);
        const w = state.wireframes.find((x) => x.name === wireframe);
        if (!w) throw new HttpError(404, `no wireframe "${wireframe}"`);
        if (w.url) openTarget(w.url, run);
        else openFolderFile(folderOf(id), w.path, run);
        return { ok: true, opened: w.url ?? w.path };
      }
      const rel = text(path ?? undefined, "path", true) ?? "";
      if (!/\.html?$/i.test(rel)) throw new HttpError(400, `${rel}: only an .html file opens in the browser`);
      openFolderFile(folderOf(id), rel, run);
      return { ok: true, opened: rel };
    }),
    r("GET", "/api/repos", () => listRepos().map(repoInfo)),
    r("POST", "/api/repos", async ({ body }) => {
      const b = await objectBody(body);
      const path = text(b.path, "path", true) ?? "";
      const name = text(b.name, "name", false);
      const base = text(b.base, "base", false);
      const repo = addRepo(path, { ...(name ? { name } : {}), ...(base ? { base } : {}) });
      deps.publish({ type: "repos" });
      return repoInfo(repo);
    }),
    r("GET", "/api/repos/:name/map", ({ params, url }) => {
      const repo = getRepo(params.name ?? "");
      const file = mapFile(repo.name);
      if (!existsSync(file)) return { map: null, errors: [] as string[] };
      const read = readMapFile(file);
      let map = read.map;
      const errors = [...read.errors];
      const chatId = url.searchParams.get("chat");
      if (map && chatId) {
        const chat = getChat(chatId);
        if (chat.featureDir && existsSync(chat.featureDir)) {
          const o = readOverlay(chat.featureDir);
          errors.push(...o.errors);
          if (o.overlay) {
            const applied = applyOverlay(map, o.overlay);
            map = applied.map;
            errors.push(...applied.errors);
          }
        }
      }
      return { map, errors };
    }),
    r("POST", "/api/repos/:name/map/import", async ({ params, body }) => {
      const repo = getRepo(params.name ?? "");
      const b = await objectBody(body);
      const file = text(b.file, "file", true) ?? "";
      if (!isAbsolute(file)) throw new HttpError(400, "the file must be an absolute path");
      try {
        importMap({ file, reposDir: paths.repos(), name: repo.name });
      } catch (e) {
        if (e instanceof MapImportError) return json({ error: e.message, errors: e.errors }, 400);
        throw e;
      }
      deps.publish({ type: "repos" });
      return { map: readMapFile(mapFile(repo.name)).map, errors: [] as string[] };
    }),
    r("POST", "/api/repos/:name/map/build", ({ params }) => {
      const repo = getRepo(params.name ?? "");
      try {
        const map = buildLowDetailMap({ repoPath: repo.path, name: repo.name });
        saveMap(repo.name, map);
        deps.publish({ type: "repos" });
        return { map, errors: [] as string[] };
      } catch (e) {
        if (e instanceof MapImportError) return json({ error: e.message, errors: e.errors }, 400);
        throw e;
      }
    }),
    r("GET", "/api/config", () => loadConfig()),
    r("PUT", "/api/config", async ({ body }) => {
      const sent = await objectBody(body);
      let config: ReturnType<typeof parseConfig>;
      try {
        // The window does not know the tool programs (bins) or the tool flags. A save that leaves them out keeps the file's own.
        const own = loadConfig();
        const b = {
          ..."bins" in sent ? {} : { bins: own.bins },
          ..."codexArgs" in sent ? {} : { codexArgs: own.codexArgs },
          ..."claudeArgs" in sent ? {} : { claudeArgs: own.claudeArgs },
          ...sent,
        };
        config = parseConfig(b, paths.config());
      } catch (e) {
        if (e instanceof ConfigError) throw new HttpError(400, e.message);
        throw e;
      }
      saveConfig(config);
      deps.publish({ type: "config" });
      return config;
    }),
    r("POST", "/api/chats/:id/wireframes/:name/link", async ({ params, body }) => {
      const id = params.id ?? "";
      const name = params.name ?? "";
      const b = await objectBody(body);
      const url = text(b.url, "url", true) ?? "";
      const dir = folderOf(id);
      try {
        setWireframeLink(dir, name, url);
      } catch (e) {
        const message = (e as Error).message;
        throw new HttpError(missing(message) ? 404 : 400, message);
      }
      changed(id);
      return { name, path: `wireframes/${name}.html`, url };
    }),
    r("GET", "/api/chats/:id/plan/check", ({ params }) => {
      const id = params.id ?? "";
      const dir = folderOf(id);
      return { problems: planProblems(dir, getChat(id).worktree) };
    }),
    r("POST", "/api/chats/:id/notes", async ({ params, body }) => {
      const id = params.id ?? "";
      const b = await objectBody(body);
      const to = b.to as NoteTarget;
      if (!TARGETS.includes(to)) throw new HttpError(400, `"to" must be one of ${TARGETS.join(", ")}`);
      const said = text(b.said, "said", true) ?? "";
      const words = text(b.note, "note", true) ?? "";
      const dir = folderOf(id);
      const chat = getChat(id);
      if (to === "repo" && !chat.repo) throw new HttpError(400, `chat "${id}" has no repo, so a note to the repo has nowhere to go`);

      // A note to the plan or the repo is recorded as read at once. A note to the orchestrator waits while the chat is halted.
      let made: Note | undefined;
      writeRunFile(join(dir, "run", "handoffs.md"), (old) => {
        const held = to === "orchestrator" && chat.halted !== null;
        const added = appendNote(old, { at: stamp(), stage: chat.stage ?? "plan", to, said, note: words, status: held ? "held" : "queued" });
        const out = to === "plan" || to === "repo" ? markRead(added.text, added.note.n, hhmm()) : added.text;
        made = parseNotes(out).notes.find((n) => n.n === added.note.n);
        return out;
      });
      if (!made) throw new HttpError(500, "the new note did not parse");
      if (to === "repo" && chat.repo) {
        const n = made;
        writeRunFile(join(paths.repos(), `${chat.repo}.notes.md`), (old) => `${old.trim() ? (old.endsWith("\n") ? old : `${old}\n`) : `# Notes: ${chat.repo}\n`}\n## ${stamp()} · ${id} · Note ${n.n}\n${n.note}\n`);
      }
      if (to === "fixes") rebuildFixes(dir);
      noteWritten(id, made);
      changed(id);
      return made;
    }),
    r("POST", "/api/chats/:id/questions", async ({ params, body }) => {
      const id = params.id ?? "";
      const b = await objectBody(body);
      const task = text(b.task, "task", true) ?? "";
      const question = text(b.text, "text", true) ?? "";
      const agent = text(b.agent, "agent", true) ?? "";
      const dir = folderOf(id);
      let made: Question | undefined;
      writeRunFile(join(dir, "run", "questions.md"), (old) => {
        const added = appendQuestion(old, { at: hhmm(), agent, task, question });
        made = added.question;
        return added.text;
      });
      if (!made) throw new HttpError(500, "the new question did not parse");
      questionAsked(id, made);
      changed(id);
      return made;
    }),
    r("POST", "/api/chats/:id/questions/:q/answer", async ({ params, body }) => {
      const id = params.id ?? "";
      const n = numberOf(params.q ?? "", "Q", "question");
      const b = await objectBody(body);
      const answer = text(b.text, "text", true) ?? "";
      const dir = folderOf(id);
      let made: Question | undefined;
      writeRunFile(join(dir, "run", "questions.md"), (old) => {
        const out = answerQuestion(old, n, hhmm(), answer);
        made = parseQuestions(out).questions.find((q) => q.n === n);
        return out;
      });
      if (!made) throw new HttpError(500, "the answered question did not parse");
      questionAnswered(id, made);
      changed(id);
      return made;
    }),
    r("POST", "/api/chats/:id/findings", async ({ params, body }) => {
      const id = params.id ?? "";
      const b = await objectBody(body);
      const sev = text(b.sev, "sev", true) ?? "";
      const where = text(b.where, "where", true) ?? "";
      const words = text(b.text, "text", true) ?? "";
      const reviewer = text(b.reviewer, "reviewer", true) ?? "";
      const dir = folderOf(id);
      const finding = addFinding(dir, { sev: sev as "high", where, text: words, reviewer });
      rebuildFixes(dir);
      deps.onFinding?.(id);
      changed(id);
      return finding;
    }),
    r("POST", "/api/chats/:id/findings/:n/dispute", async ({ params, body }) => {
      const id = params.id ?? "";
      const n = numberOf(params.n ?? "", "F", "finding");
      const b = await objectBody(body);
      const reviewer = text(b.reviewer, "reviewer", true) ?? "";
      const why = text(b.why, "why", true) ?? "";
      const dir = folderOf(id);
      const finding = disputeFinding(dir, n, reviewer, why);
      rebuildFixes(dir);
      deps.onFinding?.(id);
      changed(id);
      return finding;
    }),
    r("POST", "/api/chats/:id/findings/:n/accept", async ({ params, body }) => {
      const id = params.id ?? "";
      const n = numberOf(params.n ?? "", "F", "finding");
      // A reason is optional, and so is the body.
      const b = await body().catch(() => ({}) as Record<string, unknown>);
      const why = typeof b === "object" && b !== null && typeof b.why === "string" && b.why.trim() ? b.why : undefined;
      const dir = folderOf(id);
      const finding = decideFinding(dir, n, "accepted", why);
      rebuildFixes(dir);
      deps.onFinding?.(id);
      changed(id);
      return finding;
    }),
    r("POST", "/api/chats/:id/findings/:n/reject", async ({ params, body }) => {
      const id = params.id ?? "";
      const n = numberOf(params.n ?? "", "F", "finding");
      const b = await objectBody(body);
      const why = text(b.why, "why", true) ?? "";
      const dir = folderOf(id);
      const finding = decideFinding(dir, n, "rejected", why);
      rebuildFixes(dir);
      deps.onFinding?.(id);
      changed(id);
      return finding;
    }),
    r("POST", "/api/chats/:id/cards/:card/result", async ({ params, body }) => {
      const id = params.id ?? "";
      const b = await objectBody(body);
      const result = text(b.result, "result", true) ?? "";
      const note = text(b.note, "note", false) ?? "";
      const dir = folderOf(id);
      const card = recordCardResult(dir, params.card ?? "", result as CardResult, note);
      changed(id);
      return card;
    }),
    r("POST", "/api/refresh", async ({ url }) => {
      const id = url.searchParams.get("chat");
      deps.publish({ type: "chats" });
      deps.publish({ type: "repos" });
      if (id) deps.publish({ type: "chat", id });
      return { ok: true };
    }),
    ...(engine ? engineRoutes(deps, engine, r, changed) : []),
  ];
}

type MakeRoute = (method: Route["method"], path: string, handler: Handler) => Route;

const STAGES: readonly Stage[] = ["map", "plan", "build", "review"];

/** A list of texts: a JSON array, or one comma-separated text. */
function textList(v: unknown, what: string, minimum = 0): string[] {
  const list = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new HttpError(400, `"${what}" must be a list of texts`);
  const out = list.map((x) => (x as string).trim()).filter((x) => x !== ""); // every item is a text: checked just above
  if (out.length < minimum) throw new HttpError(400, `"${what}" needs at least ${minimum} item${minimum === 1 ? "" : "s"}`);
  return out;
}

/** The `starship task ...` command of a request body. */
function taskCommandOf(b: Record<string, unknown>): TaskCommand {
  const command = text(b.command, "command", true) ?? "";
  const id = () => text(b.id, "id", true) ?? "";
  switch (command) {
    case "add": {
      const phase = Number(b.phase);
      if (!Number.isInteger(phase) || phase < 1) throw new HttpError(400, '"phase" must be a phase number');
      const verify = text(b.verify, "verify", false);
      return { cmd: "add", phase, text: text(b.text, "text", true) ?? "", files: textList(b.files, "files", 1), ...(verify !== undefined ? { verify } : {}), parallel: b.parallel === true };
    }
    case "edit": {
      const t = text(b.text, "text", false);
      const verify = text(b.verify, "verify", false);
      return { cmd: "edit", id: id(), ...(t !== undefined ? { text: t } : {}), ...(b.files !== undefined ? { files: textList(b.files, "files", 1) } : {}), ...(verify !== undefined ? { verify } : {}) };
    }
    case "split":
      return { cmd: "split", id: id(), into: textList(b.into, "into", 2) };
    case "block":
      return { cmd: "block", id: id(), reason: text(b.reason, "reason", true) ?? "" };
    case "drop":
      return { cmd: "drop", id: id(), reason: text(b.reason, "reason", true) ?? "" };
    case "retry":
      return { cmd: "retry", id: id() };
    default:
      throw new HttpError(400, `"${command}" is not a task command`);
  }
}

/** The routes that need the running engine: the loop, the agents, the queue and the usage switch. */
function engineRoutes(deps: ApiDeps, engine: Engine, r: MakeRoute, changed: (id: string) => void): Route[] {
  const idOf = (params: Record<string, string>) => params.id ?? "";
  const agentOf = (params: Record<string, string>) => params.a ?? "";
  return [
    r("POST", "/api/chats/:id/messages", async ({ params, body }) => {
      const id = idOf(params);
      const b = await objectBody(body);
      return engine.chat.send(id, { id: typeof b.id === "string" ? b.id : "", text: typeof b.text === "string" ? b.text : "" });
    }),
    r("POST", "/api/chats/:id/messages/:mid/retry", ({ params }) => engine.chat.retry(idOf(params), params.mid ?? "")),
    r("POST", "/api/chats/:id/notes/ack", async ({ params, body }) => {
      const id = idOf(params);
      const b = await objectBody(body);
      const numbers = Array.isArray(b.numbers) ? b.numbers.map((n) => Number(typeof n === "string" ? n.replace(/^N/i, "") : n)) : [];
      if (numbers.length === 0 || !numbers.every((n) => Number.isInteger(n) && n > 0)) throw new HttpError(400, '"numbers" must be a list of note numbers');
      folderOf(id);
      engine.notes.ack(id, numbers);
      return { ok: true, numbers };
    }),
    r("POST", "/api/chats/:id/notes/:n/undo", ({ params }) => {
      const id = idOf(params);
      const n = numberOf(params.n ?? "", "N", "note");
      const dir = folderOf(id);
      const file = join(dir, "run", "handoffs.md");
      const note = parseNotes(existsSync(file) ? readFileSync(file, "utf8") : "").notes.find((x) => x.n === n);
      if (!note) throw new HttpError(404, `no note ${n}`);
      if (note.to === "orchestrator") {
        const refused = engine.notes.undo(id, n);
        if (refused) return json({ error: refused }, 409);
      } else if (note.to === "fixes" && note.status === "queued") {
        writeRunFile(file, (old) => undoNote(old, n));
        rebuildFixes(dir);
      } else {
        // A plan or repo note was read when the engine wrote it. A fixes note that is read went out with a fix list.
        return json({ error: note.status === "undone" ? "Already undone" : "Already read" }, 409);
      }
      changed(id);
      return { n, status: "undone" };
    }),
    r("POST", "/api/chats/:id/stage", async ({ params, body }) => {
      const id = idOf(params);
      const b = await objectBody(body);
      const stage = b.stage as Stage;
      if (!STAGES.includes(stage)) throw new HttpError(400, `"stage" must be one of ${STAGES.join(", ")}`);
      await engine.setStage(id, stage);
      return { ok: true, stage };
    }),
    r("POST", "/api/chats/:id/halt", async ({ params }) => {
      const id = idOf(params);
      const done = await engine.halt(id);
      changed(id);
      return { ok: true, halted: done };
    }),
    r("POST", "/api/chats/:id/resume", async ({ params }) => {
      const id = idOf(params);
      const done = await engine.resume(id);
      changed(id);
      return { ok: true, resumed: done };
    }),
    r("POST", "/api/chats/:id/agents/:a/terminal", ({ params }) => {
      const session = engine.tmuxOf(idOf(params), agentOf(params));
      const app: TerminalApp = loadConfig().terminalApp === "Terminal" ? "terminal" : "iterm";
      const opened = (deps.terminal ?? openTerminal)(session, { app });
      return { ok: true, session, app: opened.app };
    }),
    r("POST", "/api/chats/:id/agents/:a/pause", async ({ params }) => {
      await engine.pauseAgent(idOf(params), agentOf(params));
      return { ok: true };
    }),
    r("POST", "/api/chats/:id/agents/:a/resume", async ({ params }) => {
      await engine.resumeAgent(idOf(params), agentOf(params));
      return { ok: true };
    }),
    r("POST", "/api/chats/:id/agents/:a/restart", async ({ params }) => ({ ok: true, ...(await engine.restartAgent(idOf(params), agentOf(params))) })),
    r("POST", "/api/chats/:id/agents/:a/model", async ({ params, body }) => {
      const b = await objectBody(body);
      const tool = b.tool;
      if (tool !== undefined && tool !== "claude" && tool !== "codex") throw new HttpError(400, '"tool" must be "claude" or "codex"');
      const model = text(b.model, "model", false);
      if (tool === undefined && model === undefined) throw new HttpError(400, 'give a "tool" or a "model"');
      return { ok: true, ...(await engine.restartAgent(idOf(params), agentOf(params), { ...(tool ? { tool } : {}), ...(model !== undefined ? { model } : {}) })) };
    }),
    r("POST", "/api/chats/:id/tasks", async ({ params, body }) => {
      const b = await objectBody(body);
      const agent = text(b.agent, "agent", true) ?? "";
      const res = engine.taskCommand(idOf(params), agent, taskCommandOf(b));
      if (!res.ok) throw new Refused(res.error);
      return res;
    }),
    r("POST", "/api/chats/:id/check", async ({ params, body }) => {
      const b = await objectBody(body);
      return engine.runCheck(idOf(params), text(b.task, "task", true) ?? "");
    }),
    r("POST", "/api/chats/:id/fixes/send", ({ params }) => ({ ok: true, ...engine.sendFixes(idOf(params)) })),
    r("POST", "/api/chats/:id/findings/none", async ({ params, body }) => {
      const id = idOf(params);
      const b = await objectBody(body);
      markNoFindings(folderOf(id), text(b.reviewer, "reviewer", true) ?? "");
      deps.onFinding?.(id);
      changed(id);
      return { ok: true };
    }),
    r("POST", "/api/chats/:id/map/overlay", async ({ params, body }) => {
      const id = idOf(params);
      const b = await objectBody(body);
      const file = text(b.file, "file", true) ?? "";
      if (!isAbsolute(file)) throw new HttpError(400, "the file must be an absolute path");
      if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(400, `${file} is not a file`);
      const dir = folderOf(id);
      const chat = getChat(id);
      if (!chat.repo) throw new Refused(`Chat "${id}" has no repo, so it has no map`);
      const mapPath = mapFile(chat.repo);
      if (!existsSync(mapPath)) throw new Refused(`Repo "${chat.repo}" has no map yet`);
      const base = readMapFile(mapPath).map;
      if (!base) throw new Refused(`The map of repo "${chat.repo}" cannot be read`);
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return json({ error: `${file} is not valid JSON`, errors: [`${file} is not valid JSON`] }, 400);
      }
      const errors = overlayShape(value);
      // overlayShape proved the shape when it found no error.
      if (errors.length === 0) errors.push(...applyOverlay(base, value as Parameters<typeof applyOverlay>[1]).errors);
      if (errors.length > 0) return json({ error: `The overlay has ${errors.length} error${errors.length === 1 ? "" : "s"}`, errors }, 400);
      writeRunFile(join(dir, "run", "map-overlay.json"), () => `${JSON.stringify(value, null, 2)}\n`);
      changed(id);
      return { ok: true, errors: [] as string[] };
    }),
    r("GET", "/api/usage", () => engine.usage.state()),
    r("GET", "/api/chats/:id/code", ({ params, url }) => {
      const chat = getChat(idOf(params));
      if (!chat.worktree) throw new HttpError(404, `chat "${chat.id}" has no worktree`);
      const path = text(url.searchParams.get("path") ?? undefined, "path", true) ?? "";
      const { info, text: content } = readFileSafe(chat.worktree, path);
      return { info, text: content, open: false };
    }),
    r("POST", "/api/hook", async ({ body }) => {
      const b = await objectBody(body);
      const id = text(b.chat, "chat", true) ?? "";
      getChat(id);
      engine.sessions.applyNow(id);
      changed(id);
      return { ok: true };
    }),
  ];
}
