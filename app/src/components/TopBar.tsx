import type { AgentView, Chat, Stage } from "../../../engine/src/types.ts";
import { agentDot, STAGES } from "../format.ts";

/** The page in the middle, as the top bar names it. */
export type PageId = Stage | "tasks" | "files" | "file" | "agent";

export interface TopBarProps {
  chat: Chat;
  agents: AgentView[];
  /** The page on screen. */
  page: PageId;
  /** The id of the agent whose page is on screen. */
  agentId?: string | null;
  onStage: (stage: Stage) => void;
  onPage: (page: "tasks" | "files") => void;
  onAgent: (id: string) => void;
  /** The map page hides the conversation. This tab shows it again. Absent on the other pages. */
  chatTab?: { on: boolean; onToggle: () => void };
}

const PAGES: { id: "tasks" | "files"; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "files", label: "Files" },
];

export function TopBar({ chat, agents, page, agentId = null, onStage, onPage, onAgent, chatTab }: TopBarProps) {
  return (
    <header className="top">
      <span className="ttl">{chat.title}</span>
      {chat.stage !== null && (
        <>
          <nav className="tabs" aria-label="Stages">
            {STAGES.map((s) => (
              <button key={s.id} type="button" className="tab" aria-current={page === s.id} data-own={chat.stage === s.id} onClick={() => onStage(s.id)}>
                {s.label}
              </button>
            ))}
          </nav>
          <nav className="tabs" aria-label="Documents">
            {PAGES.map((p) => (
              <button key={p.id} type="button" className="tab" aria-current={page === p.id || (p.id === "files" && page === "file")} onClick={() => onPage(p.id)}>
                {p.label}
              </button>
            ))}
          </nav>
          {chatTab && (
            <button type="button" className="tab" aria-pressed={chatTab.on} onClick={chatTab.onToggle}>
              Chat
            </button>
          )}
        </>
      )}
      <span className="grow" />
      {agents.map((a) => (
        <button key={a.id} type="button" className={page === "agent" && agentId === a.id ? "ag on" : "ag"} data-agent={a.id} onClick={() => onAgent(a.id)}>
          <span className={`dot ${agentDot(a.status)}`.trim()} />
          {a.name}
        </button>
      ))}
    </header>
  );
}
