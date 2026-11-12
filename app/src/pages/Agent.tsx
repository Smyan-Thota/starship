import { useState } from "react";
import type { AgentView, Tool } from "../../../engine/src/types.ts";
import "../chat/chat.css";
import { AGENT_STATUS, agentDot } from "../format.ts";

export interface PromptVersionView {
  version: number;
  /** Path of the prompt file. A worker has one file per task, and each starts at v1, so the version alone does not name it. */
  file?: string;
  /** HH:MM */
  at: string;
  /** The exact prompt text. */
  text: string;
  /** The same text by line. `said` holds the owner's words when the line came from a note. */
  lines: { text: string; said: string | null }[];
}

export interface AgentPageProps {
  agent: Pick<AgentView, "role" | "tool" | "model" | "status" | "task" | "tmux"> & { name?: string; contextPct?: number | null };
  /** Any order. The newest version shows first. */
  prompts: PromptVersionView[];
  onTerminal: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  /** null = the engine took the tool and the model. A string = its refusal, shown as it is. */
  onModel: (tool: Tool, model: string) => Promise<string | null>;
}

const TOOL: Record<Tool, string> = { claude: "Claude Code", codex: "Codex" };

const ROLE: Record<AgentView["role"], string> = {
  admin: "Admin",
  orchestrator: "Orchestrator",
  worker: "Worker",
  reviewer: "Reviewer",
  cardRunner: "Card runner",
};

/** "v2 · 15:06", or "T022 v1 · 15:06" for a worker's prompt of one task. */
function tabLabel(p: PromptVersionView): string {
  const task = p.file?.match(/-(T\d{3}[A-Za-z]?)-v\d+\.md$/)?.[1];
  return `${task ? `${task} ` : ""}v${p.version} · ${p.at}`;
}

/** The exact text of the prompt, blank lines and indents as they are. A line that came from a note shows the owner's words. */
function PromptBody({ version }: { version: PromptVersionView }) {
  const said = new Map(version.lines.flatMap((l) => (l.said ? [[l.text, l.said] as const] : [])));
  const lines = version.text.split("\n");
  return (
    <div className="ap-prompt">
      {lines.map((text, i) => {
        const owner = said.get(text.trim());
        return (
          // Lines have no id and never reorder within a version, so the index is the key.
          <div key={i} className={owner ? "ap-line mine" : "ap-line"}>
            {owner && <span className="ap-said">You: {owner}</span>}
            {i < lines.length - 1 ? `${text}\n` : text}
          </div>
        );
      })}
    </div>
  );
}

/** The tool and the model of the agent. Apply stays off until one of them differs from what the agent has. */
function ModelControl({ agent, onModel }: { agent: AgentPageProps["agent"]; onModel: AgentPageProps["onModel"] }) {
  // null = not edited: the field follows the agent, so a change from the engine shows.
  const [tool, setTool] = useState<Tool | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const shownTool = tool ?? agent.tool;
  const shownModel = model ?? agent.model;
  const changed = shownTool !== agent.tool || shownModel !== agent.model;

  const apply = () => {
    if (busy || !changed) return;
    setBusy(true);
    setRefusal(null);
    const done = (err: string | null) => {
      setBusy(false);
      setRefusal(err);
      if (err === null) {
        setTool(null);
        setModel(null);
      }
    };
    onModel(shownTool, shownModel.trim()).then(done, (e: unknown) => done(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      <select aria-label="Tool" className="ap-in" value={shownTool} onChange={(e) => setTool(e.target.value === "codex" ? "codex" : "claude")}>
        {(Object.keys(TOOL) as Tool[]).map((t) => (
          <option key={t} value={t}>
            {TOOL[t]}
          </option>
        ))}
      </select>
      <input aria-label="Model" className="ap-in mono" autoComplete="off" value={shownModel} onChange={(e) => setModel(e.target.value)} />
      <button type="button" className="btn" disabled={!changed || busy} onClick={apply}>
        Apply
      </button>
      {refusal !== null && (
        <span role="alert" className="red">
          {refusal}
        </span>
      )}
    </>
  );
}

export function AgentPage({ agent, prompts, onTerminal, onPause, onResume, onRestart, onModel }: AgentPageProps) {
  // The sort is stable: two prompts of one version (one per task) stay in the order the engine gave them.
  const sorted = [...prompts].sort((a, b) => a.version - b.version);
  const [chosen, setChosen] = useState<number | null>(null);
  const shownAt = chosen !== null && chosen < sorted.length ? chosen : sorted.length - 1;
  const shown = sorted[shownAt];
  const { status } = agent;

  return (
    <>
      <h1>{agent.name ?? ROLE[agent.role]}</h1>
      <dl className="props">
        <dt>Status</dt>
        <dd>
          <span className={`dot ${agentDot(status)}`.trim()} />
          {AGENT_STATUS[status]}
        </dd>
        {agent.task && (
          <>
            <dt>Task</dt>
            <dd>{agent.task}</dd>
          </>
        )}
        <dt>Role</dt>
        <dd>{ROLE[agent.role]}</dd>
        <dt>Tool</dt>
        <dd>{TOOL[agent.tool]}</dd>
        <dt>Model</dt>
        <dd className="mono">{agent.model}</dd>
        {typeof agent.contextPct === "number" && (
          <>
            <dt>Context</dt>
            <dd>{Math.round(agent.contextPct)}%</dd>
          </>
        )}
        <dt>Session</dt>
        <dd className="mono">{agent.tmux}</dd>
      </dl>
      <div className="row" style={{ margin: "14px 0 4px" }}>
        <button type="button" className="btn" onClick={onTerminal}>
          Terminal
        </button>
        {status === "working" && (
          <button type="button" className="btn" onClick={onPause}>
            Pause
          </button>
        )}
        {status === "paused" && (
          <button type="button" className="btn" onClick={onResume}>
            Resume
          </button>
        )}
        {(status === "stalled" || status === "stopped") && (
          <button type="button" className="btn" onClick={onRestart}>
            Restart
          </button>
        )}
        <ModelControl agent={agent} onModel={onModel} />
      </div>
      {shown && (
        <>
          <h2>Prompt</h2>
          {sorted.length > 1 && (
            <div className="tabs" style={{ marginBottom: 8 }}>
              {sorted.map((p, i) => (
                <button key={`${p.file ?? ""}:${p.version}:${i}`} type="button" className="tab" aria-current={i === shownAt} onClick={() => setChosen(i)}>
                  {tabLabel(p)}
                </button>
              ))}
            </div>
          )}
          <PromptBody version={shown} />
        </>
      )}
    </>
  );
}
