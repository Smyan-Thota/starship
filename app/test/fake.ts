/**
 * A fake store for the App tests: every action is a mock that records its arguments and answers "done".
 * Not a test file: bun runs only *.test.* files.
 */
import { mock } from "bun:test";
import type { ChatState, FileInfo } from "../../engine/src/types.ts";
import type { AppActions } from "../src/actions.ts";
import type { AppProps } from "../src/App.tsx";
import { sampleChats, sampleConfig, sampleLoadCode, sampleLoadFile, sampleMap, sampleRepos, sampleState, sampleUsage } from "../src/sample.ts";

/** 2026-11-11 15:30 UTC. The sample usage resets after it. */
export const NOW = Date.parse("2026-11-11T15:30:00.000Z");

type Mocked = { [K in keyof AppActions]: ReturnType<typeof mock<AppActions[K]>> };

/** Each action is a mock. Pass a function to change one answer. */
export function fakeActions(over: Partial<AppActions> = {}): Mocked & AppActions {
  const done = () => Promise.resolve(null);
  const a: AppActions = {
    selectChat: () => {},
    setDraft: () => {},
    send: () => Promise.resolve(true),
    retry: done,
    undo: done,
    createChat: done,
    addRepo: done,
    saveConfig: done,
    setSwitch: done,
    setThreshold: done,
    stage: done,
    halt: done,
    resume: done,
    agent: done,
    agentModel: done,
    sendFixes: done,
    openInBrowser: done,
    loadFile: sampleLoadFile,
    loadCode: sampleLoadCode,
    loadMap: () => Promise.resolve({ map: sampleMap, errors: [] }),
    buildMap: done,
    ...over,
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = mock(v as (...args: never[]) => unknown);
  // Each entry is the mock of the action of the same name, so the cast only restores the keys.
  return out as unknown as Mocked & AppActions;
}

export function appProps(state: ChatState | null, actions: AppActions = fakeActions(), extra: Partial<AppProps> = {}): AppProps {
  return { chats: sampleChats, state, repos: sampleRepos, config: sampleConfig, usage: sampleUsage, now: NOW, actions, ...extra };
}

export function info(path: string, extra: Partial<FileInfo> = {}): FileInfo {
  return { path, kind: path.startsWith("run/") ? "run" : "plan", size: 100, mtimeMs: 0, binary: false, tooLarge: false, html: path.endsWith(".html"), ...extra };
}

/** A chat with no repo: a plain conversation. */
export function noRepoState(): ChatState {
  return {
    chat: { id: "release-notes", title: "Release notes", repo: null, stage: null, halted: null, needsYou: 0, slug: null, worktree: null, branch: null, featureDir: null, createdAt: "2026-11-11T10:00:00.000Z" },
    build: { status: "notStarted", reason: null, outside: [], dropped: [], lastFixSent: 0 },
    needs: [],
    plan: null,
    review: null,
    folderMissing: false,
    tasks: null,
    tasksError: null,
    notes: [],
    unreadableNotes: [],
    questions: [],
    files: [],
    wireframes: [],
    messages: [],
    agents: [],
    queue: [],
    events: [],
    handEdits: [],
  };
}

/** The sample chat with changes. */
export function withState(patch: Partial<ChatState>): ChatState {
  return { ...sampleState, ...patch };
}
