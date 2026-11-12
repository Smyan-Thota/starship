/**
 * The window: the chat list on the left, the open chat in the middle and on the right.
 * App holds view state only (the new chat form, settings). Every piece of data and every action comes in through
 * props, so a test feeds it sample data and a fake store, and `Live` feeds it the engine.
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ChatState, ChatSummary, RepoInfo, UsageState } from "../../engine/src/types.ts";
import type { AppActions } from "./actions.ts";
import { usageData } from "./adapters.ts";
import { ChatView } from "./ChatView.tsx";
import { NewChat } from "./components/NewChat.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SettingsPage, type SettingsConfig } from "./pages/Settings.tsx";
import { UsageBars } from "./Usage.tsx";

export interface AppProps {
  chats: ChatSummary[];
  /** The open chat. null while nothing is open. */
  state: ChatState | null;
  repos: RepoInfo[];
  /** null until the engine sent it. */
  config: SettingsConfig | null;
  /** null until the engine sent it. */
  usage: UsageState | null;
  /** The connection label, for example "Offline". null or absent when all is well. */
  status?: string | null;
  /** The open chat's unsent text, put back in the input. */
  draft?: string;
  /** The clock of the usage bars, in epoch milliseconds. A test sets it. */
  now?: number;
  actions: AppActions;
}

type Screen = "chat" | "new" | "settings";

/** The clock of the usage bars. It moves once a minute. */
function useNow(fixed: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ?? now;
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <header className="top">
        <span className="ttl">{title}</span>
      </header>
      <main className="doc">
        <div className="page">
          <div className="pg">{children}</div>
        </div>
      </main>
    </>
  );
}

export function App({ chats, state, repos, config, usage, status = null, draft = "", now: fixedNow, actions }: AppProps) {
  const [screen, setScreen] = useState<Screen>("chat");
  // The chat whose count the owner clicked, until that chat has opened on what waits.
  const [focusChat, setFocusChat] = useState<string | null>(null);
  const now = useNow(fixedNow);
  const clearFocus = useCallback(() => setFocusChat(null), []);

  const bars = usage ? <UsageBars {...usageData(usage, now)} onSwitch={(on) => void actions.setSwitch(on)} onThreshold={(pct) => void actions.setThreshold(pct)} /> : null;
  const solo = screen === "chat" && state !== null && state.chat.stage === null;

  return (
    <div className={screen !== "chat" ? "app nochat" : solo ? "app solo" : "app"}>
      <Sidebar
        chats={chats}
        activeId={screen === "chat" ? (state?.chat.id ?? null) : null}
        screen={screen}
        status={status}
        usage={bars ? <div className="side-use">{bars}</div> : null}
        onSelectChat={(id) => {
          setScreen("chat");
          actions.selectChat(id);
        }}
        onNeeds={(id) => {
          setScreen("chat");
          setFocusChat(id);
          actions.selectChat(id);
        }}
        onNewChat={() => setScreen("new")}
        onSettings={() => setScreen("settings")}
      />
      {screen === "new" ? (
        <Page title="New chat">
          <NewChat
            repos={repos}
            onCreate={async (input) => {
              const err = await actions.createChat(input);
              if (err === null) setScreen("chat");
              return err;
            }}
            onAddRepo={actions.addRepo}
            onCancel={() => setScreen("chat")}
          />
        </Page>
      ) : screen === "settings" ? (
        <Page title="Settings">{config ? <SettingsPage config={config} onSave={actions.saveConfig} /> : <p className="mut">Loading</p>}</Page>
      ) : state ? (
        <ChatView key={state.chat.id} state={state} repos={repos} draft={draft} focus={focusChat === state.chat.id} onFocused={clearFocus} actions={actions} />
      ) : (
        <>
          <header className="top" />
          <main className="doc" />
          <section className="chat" aria-label="Admin chat" />
        </>
      )}
    </div>
  );
}
