/**
 * What the window can ask of the engine. App takes this one object, so a test hands it a fake store
 * and `Live` hands it the live data layer.
 *
 * A promise of null means the engine did it. A string is the text to show: the engine's own refusal,
 * or "Offline" when it cannot be reached.
 */
import type { FileBody, Stage, Tool } from "../../engine/src/types.ts";
import type { AgentAction, LiveData, MapAnswer, NewChatInput } from "./data.ts";
import type { SettingsConfig } from "./pages/Settings.tsx";

export type { AgentAction, MapAnswer, NewChatInput };

export interface AppActions {
  selectChat: (id: string) => void;
  /** Keeps what is in the input of the open chat. */
  setDraft: (text: string) => void;
  /** Resolves true when the engine has the text. False keeps it in the input. */
  send: (text: string) => Promise<boolean>;
  retry: (messageId: string) => Promise<string | null>;
  undo: (note: number) => Promise<string | null>;
  createChat: (input: NewChatInput) => Promise<string | null>;
  addRepo: (path: string) => Promise<string | null>;
  saveConfig: (config: SettingsConfig) => Promise<string | null>;
  setSwitch: (on: boolean) => Promise<string | null>;
  setThreshold: (pct: number) => Promise<string | null>;
  stage: (stage: Stage) => Promise<string | null>;
  halt: () => Promise<string | null>;
  resume: () => Promise<string | null>;
  agent: (id: string, action: AgentAction) => Promise<string | null>;
  agentModel: (id: string, tool: Tool, model: string) => Promise<string | null>;
  sendFixes: () => Promise<string | null>;
  openInBrowser: (path: string) => Promise<string | null>;
  loadFile: (path: string) => Promise<FileBody>;
  /** A file of the chat's worktree that is not a plan file. */
  loadCode: (path: string) => Promise<FileBody>;
  loadMap: (repo: string, chat: string) => Promise<MapAnswer>;
  buildMap: (repo: string) => Promise<string | null>;
}

/** The live data layer, as the window's actions. */
export function liveActions(live: LiveData): AppActions {
  return {
    selectChat: (id) => live.select(id),
    setDraft: (text) => live.setDraft(text),
    send: (text) => live.send(text),
    retry: (id) => live.retryMessage(id),
    undo: (n) => live.undo(n),
    createChat: (input) => live.createChat(input),
    addRepo: (path) => live.addRepo(path),
    saveConfig: (config) => live.saveConfig(config),
    setSwitch: (on) => live.setSwitch(on),
    setThreshold: (pct) => live.setThreshold(pct),
    stage: (stage) => live.stage(stage),
    halt: () => live.halt(),
    resume: () => live.resume(),
    agent: (id, action) => live.agent(id, action),
    agentModel: (id, tool, model) => live.agentModel(id, tool, model),
    sendFixes: () => live.sendFixes(),
    openInBrowser: (path) => live.openInBrowser(path),
    loadFile: (path) => live.loadFile(path),
    loadCode: (path) => live.loadCode(path),
    loadMap: (repo, chat) => live.loadMap(repo, chat),
    buildMap: (repo) => live.buildMap(repo),
  };
}
