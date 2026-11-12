/**
 * The open chat: the top bar, one page in the middle, the conversation on the right.
 * It holds view state only: which page is open, and the open flow of the map.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ChatState, RepoInfo, Stage } from "../../engine/src/types.ts";
import type { AppActions } from "./actions.ts";
import { buildData, planData, promptVersions, reviewData } from "./adapters.ts";
import { ChatPane } from "./chat/ChatPane.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { MapTab } from "./map/MapTab.tsx";
import { AgentPage } from "./pages/Agent.tsx";
import { BuildPage } from "./pages/Build.tsx";
import { FileView } from "./pages/FileView.tsx";
import { Files } from "./pages/Files.tsx";
import { PlanPage } from "./pages/Plan.tsx";
import { ReviewPage } from "./pages/Review.tsx";
import { Tasks } from "./pages/Tasks.tsx";

export interface ChatViewProps {
  state: ChatState;
  repos: RepoInfo[];
  /** The open chat's unsent text. */
  draft: string;
  /** True when the owner asked for what waits in this chat, from its count in the chat list. The chat opens on Build. */
  focus?: boolean;
  /** Called once the chat has opened on what waits. */
  onFocused?: () => void;
  actions: AppActions;
}

/** `code` is a file of the worktree that is not a plan file. It loads through the code route and shows as read-only text. */
type View = { k: "stage"; stage: Stage } | { k: "tasks" } | { k: "files" } | { k: "file"; path: string; code?: boolean } | { k: "agent"; id: string };

const isHtml = (path: string) => /\.html?$/i.test(path);

function StartReview({ actions }: { actions: AppActions }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const start = () => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    actions.stage("review").then(
      (err) => {
        setBusy(false);
        setRefusal(err);
      },
      (e: unknown) => {
        setBusy(false);
        setRefusal(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <div className="pb-actions" style={{ marginTop: 0, marginBottom: 14 }}>
      <button type="button" className="btn blue" disabled={busy} onClick={start}>
        Start review
      </button>
      {refusal !== null && (
        <span role="alert" className="red">
          {refusal}
        </span>
      )}
    </div>
  );
}

export function ChatView({ state, repos, draft, focus = false, onFocused, actions }: ChatViewProps) {
  const { chat } = state;
  const own = chat.stage;
  const [view, setView] = useState<View>(own ? { k: "stage", stage: own } : { k: "tasks" });
  const [flow, setFlow] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // The map page takes the width of the conversation. The Chat tab brings the conversation back.
  const [chatOn, setChatOn] = useState(false);

  const go = (v: View) => {
    setNotice(null);
    setChatOn(false);
    setView(v);
  };
  /** Runs an action whose answer has no place of its own on a page. A refusal shows at the top. */
  const run = (p: Promise<string | null>) => {
    p.then(setNotice, (e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  };
  // The count in the chat list leads to what waits: the Build tab, or for a chat with no repo, the conversation alone.
  useEffect(() => {
    if (!focus) return;
    setNotice(null);
    setChatOn(false);
    setView(own === null ? { k: "tasks" } : { k: "stage", stage: "build" });
    onFocused?.();
  }, [focus, own, onFocused]);
  const openFile = (path: string) => (isHtml(path) ? run(actions.openInBrowser(path)) : go({ k: "file", path }));

  const admin = state.agents.find((a) => a.role === "admin");
  const pane = (
    <ChatPane
      messages={state.messages}
      notes={state.notes}
      questions={state.questions}
      needs={state.needs}
      onAgent={(id) => go({ k: "agent", id })}
      onAgentTerminal={(id) => run(actions.agent(id, "terminal"))}
      adminStatus={admin?.status ?? null}
      draft={draft}
      onDraft={actions.setDraft}
      onSend={actions.send}
      onRetry={(id) => run(actions.retry(id))}
      onUndo={actions.undo}
      onTerminal={() => run(actions.agent(admin?.id ?? "admin", "terminal"))}
    />
  );

  const agentPage = (id: string): ReactNode => {
    const agent = state.agents.find((a) => a.id === id);
    return agent ? (
      <AgentPage
        key={agent.id}
        agent={agent}
        prompts={promptVersions(agent, state)}
        onTerminal={() => run(actions.agent(agent.id, "terminal"))}
        onPause={() => run(actions.agent(agent.id, "pause"))}
        onResume={() => run(actions.agent(agent.id, "resume"))}
        onRestart={() => run(actions.agent(agent.id, "restart"))}
        onModel={(tool, model) => actions.agentModel(agent.id, tool, model)}
      />
    ) : (
      <p className="mut">No agent</p>
    );
  };

  // A chat with no repo holds the conversation. An agent's page opens beside it; the same agent again closes it.
  if (own === null) {
    const open = view.k === "agent" ? view.id : null;
    return (
      <>
        <TopBar
          chat={chat}
          agents={state.agents}
          page={open ? "agent" : "tasks"}
          agentId={open}
          onStage={() => {}}
          onPage={() => {}}
          onAgent={(id) => go(id === open ? { k: "tasks" } : { k: "agent", id })}
        />
        {open !== null && (
          <main className="doc">
            <div className="page">
              <div className="pg">
                {notice !== null && (
                  <p role="alert" className="red">
                    {notice}
                  </p>
                )}
                {agentPage(open)}
              </div>
            </div>
          </main>
        )}
        {pane}
      </>
    );
  }

  let page: ReactNode = null;
  let wide = false;
  if (view.k === "stage" && view.stage === "map") {
    wide = true;
    const repo = chat.repo;
    const info = repos.find((r) => r.name === repo);
    const overlay = state.files.find((f) => f.path === "run/map-overlay.json");
    page = repo ? (
      <MapTab repo={repo} chat={chat.id} version={`${info?.hasMap ?? ""}:${overlay?.mtimeMs ?? ""}`} actions={actions} flow={flow} onFlow={setFlow} />
    ) : null;
  } else if (view.k === "stage" && view.stage === "plan") {
    page = (
      <PlanPage
        {...planData(state)}
        onOpenFile={(file) => openFile(file)}
        onOpenWireframe={(name) => {
          const w = state.wireframes.find((x) => x.name === name);
          if (w) run(actions.openInBrowser(w.path));
        }}
        onStartBuild={async () => {
          const err = await actions.stage("build");
          if (err === null) go({ k: "stage", stage: "build" });
          return err;
        }}
      />
    );
  } else if (view.k === "stage" && view.stage === "build") {
    page = (
      <BuildPage
        {...buildData(state)}
        onHalt={() => run(actions.halt())}
        onResume={() => run(actions.resume())}
        onAgent={(id) => go({ k: "agent", id })}
        onTerminal={(id) => run(actions.agent(id, "terminal"))}
        onOpenTasks={() => go({ k: "tasks" })}
      />
    );
  } else if (view.k === "stage") {
    page = (
      <>
        {own === "build" && <StartReview actions={actions} />}
        <ReviewPage
          {...reviewData(state)}
          onTerminal={(id) => run(actions.agent(id, "terminal"))}
          onAgent={(id) => go({ k: "agent", id })}
          onOpenFile={(where) => {
            const path = where.replace(/:\d+(-\d+)?$/, "");
            if (state.files.some((f) => f.path === path)) openFile(path);
            else go({ k: "file", path, code: true });
          }}
          onSendFixes={actions.sendFixes}
        />
      </>
    );
  } else if (view.k === "tasks") page = <Tasks state={state} />;
  else if (view.k === "files") page = <Files state={state} onOpenFile={openFile} onOpenInBrowser={(p) => run(actions.openInBrowser(p))} />;
  else if (view.k === "file") {
    const info = state.files.find((f) => f.path === view.path);
    page = view.code ? (
      <FileView key={`code:${view.path}`} path={view.path} loadFile={actions.loadCode} onOpenInBrowser={(p) => run(actions.openInBrowser(p))} plain />
    ) : (
      <FileView
        // A change to the file on disk reads it again.
        key={`${view.path}:${info?.mtimeMs ?? ""}:${info?.size ?? ""}`}
        path={view.path}
        info={info}
        loadFile={actions.loadFile}
        onOpenInBrowser={(p) => run(actions.openInBrowser(p))}
      />
    );
  } else {
    page = agentPage(view.id);
  }

  const current = view.k === "stage" ? view.stage : view.k;
  const mapOpen = wide && !chatOn;
  return (
    <>
      <TopBar
        chat={chat}
        agents={state.agents}
        page={current}
        agentId={view.k === "agent" ? view.id : null}
        onStage={(stage) => go({ k: "stage", stage })}
        onPage={(p) => go({ k: p })}
        onAgent={(id) => go({ k: "agent", id })}
        {...(wide ? { chatTab: { on: chatOn, onToggle: () => setChatOn((v) => !v) } } : {})}
      />
      <main className="doc" data-wide={mapOpen}>
        <div className="page">
          <div className={wide ? "pg wide" : "pg"}>
            {notice !== null && (
              <p role="alert" className="red">
                {notice}
              </p>
            )}
            {page}
          </div>
        </div>
      </main>
      {pane}
    </>
  );
}
