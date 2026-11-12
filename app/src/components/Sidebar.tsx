import type { ReactNode } from "react";
import type { ChatSummary } from "../../../engine/src/types.ts";
import { chatDot, stageLabel } from "../format.ts";

export interface SidebarProps {
  chats: ChatSummary[];
  activeId: string | null;
  /** The usage bars, at the bottom. */
  usage?: ReactNode;
  /** The connection label, for example "Offline". */
  status?: string | null;
  /** Which entry the page behind it is: a chat, the new chat form, or settings. */
  screen?: "chat" | "new" | "settings";
  onSelectChat: (id: string) => void;
  /** The count of a chat was clicked: open the chat on what waits. */
  onNeeds: (id: string) => void;
  onNewChat: () => void;
  onSettings: () => void;
}

export function Sidebar({ chats, activeId, usage, status, screen = "chat", onSelectChat, onNeeds, onNewChat, onSettings }: SidebarProps) {
  return (
    <aside className="side" aria-label="Chats">
      <div className="ws">
        Starship
        {status && (
          <span className="conn" role="status">
            {status}
          </span>
        )}
      </div>
      <button type="button" className={screen === "new" ? "it on" : "it"} onClick={onNewChat}>
        <span className="n">＋ New chat</span>
      </button>
      <div className="sl">Chats</div>
      {chats.map((c) => (
        <div key={c.id} className="itw">
          <button type="button" className={c.id === activeId ? "it on" : "it"} aria-current={c.id === activeId} data-chat={c.id} onClick={() => onSelectChat(c.id)}>
            <span className={`dot ${chatDot(c)}`.trim()} />
            <span className="n">{c.title}</span>
            <small>{stageLabel(c.stage)}</small>
          </button>
          {c.needsYou > 0 && (
            <button type="button" className="cnt" aria-label="Needs you" data-needs={c.id} onClick={() => onNeeds(c.id)}>
              {c.needsYou}
            </button>
          )}
        </div>
      ))}
      <div className="grow" />
      <button type="button" className={screen === "settings" ? "it on" : "it"} onClick={onSettings}>
        <span className="n">Settings</span>
      </button>
      {usage}
    </aside>
  );
}
