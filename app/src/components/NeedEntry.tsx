import "./need.css";

/** One line of the needs-you list, as the engine sends it. */
export interface NeedItem {
  kind: string;
  text: string;
  agent: string | null;
  task: string | null;
}

/** The words of an entry. A trust question and a permission read by the agent; the others keep the engine's text. */
export function needText(n: Pick<NeedItem, "kind" | "text" | "agent">): string {
  if (n.agent !== null && n.kind === "trust") return `${n.agent} · trust question`;
  if (n.agent !== null && n.kind === "permission") return `${n.agent} · permission`;
  return `${n.kind} · ${n.text}`;
}

/** The agent shows beside the text only when the text does not already name it. */
const NAMES_AGENT = ["trust", "permission"];

export interface NeedEntryProps {
  need: NeedItem;
  onAgent: (id: string) => void;
  onTerminal: (id: string) => void;
}

/**
 * One needs-you entry. An entry that names an agent opens that agent's page on a click and has a Terminal button.
 * An entry with no agent is plain text.
 */
export function NeedEntry({ need, onAgent, onTerminal }: NeedEntryProps) {
  const { agent } = need;
  const inner = (
    <>
      <span className="id">{need.task ?? ""}</span>
      <span>{needText(need)}</span>
      <span className="s">{agent !== null && !NAMES_AGENT.includes(need.kind) ? agent : ""}</span>
    </>
  );
  return (
    <li className="need" data-need={need.kind}>
      {agent === null ? (
        <div className="need-main">{inner}</div>
      ) : (
        <>
          <button type="button" className="need-main" onClick={() => onAgent(agent)}>
            {inner}
          </button>
          <button type="button" className="btn" onClick={() => onTerminal(agent)}>
            Terminal
          </button>
        </>
      )}
    </li>
  );
}
