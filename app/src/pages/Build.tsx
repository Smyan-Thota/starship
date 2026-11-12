import type { ReactNode } from "react";
import { NeedEntry } from "../components/NeedEntry.tsx";
import { AGENT_STATUS, TASK_STATE } from "../format.ts";
import "./plan-build.css";

export type BuildStatus = "notStarted" | "running" | "stopped" | "done";

/** Why the build stopped. Only a checkpoint stop ends with Resume. */
export interface BuildStopReason {
  kind: "tasks" | "folder" | "checkpoint";
  text: string;
}

export interface BuildPhase {
  n: number;
  title: string;
  verified: number;
  total: number;
}

export interface BuildNow {
  task: string;
  text: string;
  agent: string | null;
  state: string;
}

export interface BuildDropped {
  task: string;
  text: string;
  reason: string;
}

export interface BuildNeed {
  kind: string;
  text: string;
  agent: string | null;
  task: string | null;
}

export interface BuildAgent {
  id: string;
  role: string;
  tool: string;
  model: string;
  status: string;
  task: string | null;
  promptVersion: number;
}

export interface BuildPageProps {
  status: BuildStatus;
  /** Set when the status is "stopped". */
  reason: BuildStopReason | null;
  /** HH:MM when the chat is halted. */
  halted: string | null;
  phases: BuildPhase[];
  /** One row per running or waiting task. */
  now: BuildNow[];
  /** Changed files that no task lists. */
  outside: string[];
  dropped: BuildDropped[];
  needsYou: BuildNeed[];
  agents: BuildAgent[];
  onHalt: () => void;
  onResume: () => void;
  onAgent: (id: string) => void;
  onTerminal: (id: string) => void;
  onOpenTasks: () => void;
}

const STATUS_LABEL: Record<BuildStatus, string> = {
  notStarted: "Not started",
  running: "Running",
  stopped: "Stopped",
  done: "Done",
};

/** A status or state word as the window shows it: the shared label when there is one, else the word itself. */
function word(s: string): string {
  // The casts only index the label tables. The fallback covers a word that is not in them.
  return (AGENT_STATUS as Record<string, string>)[s] ?? (TASK_STATE as Record<string, string>)[s] ?? s;
}

function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section aria-label={name}>
      <h3>{name}</h3>
      {children}
    </section>
  );
}

export function BuildPage(p: BuildPageProps) {
  const resumable = p.halted !== null || (p.status === "stopped" && p.reason?.kind === "checkpoint");
  return (
    <>
      <div className="pb-head">
        <h1>Build</h1>
        <div className="row">
          {p.halted !== null && <span className="red">Halted {p.halted}</span>}
          <button type="button" className="btn" onClick={p.onOpenTasks}>
            Tasks
          </button>
          {p.halted === null && (
            <button type="button" className="btn red" onClick={p.onHalt}>
              Halt
            </button>
          )}
          {resumable && (
            <button type="button" className="btn blue" onClick={p.onResume}>
              Resume
            </button>
          )}
        </div>
      </div>
      <dl className="props">
        <dt>Status</dt>
        <dd>
          <span>{STATUS_LABEL[p.status]}</span>
          {p.status === "stopped" && p.reason && <span className="red">{p.reason.text}</span>}
        </dd>
      </dl>

      <table className="pb-table">
        <thead>
          <tr>
            <th>Phase</th>
            <th>Verified</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {p.phases.map((ph) => (
            <tr key={ph.n}>
              <td>
                {ph.n} · {ph.title}
              </td>
              <td>{ph.verified}</td>
              <td>{ph.total}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Section name="Now">
        {p.now.length === 0 ? (
          <p className="mut">Nothing</p>
        ) : (
          <ul className="pb-list">
            {p.now.map((n) => (
              <li key={n.task} className="pb-row" data-task={n.task}>
                <span className="id">{n.task}</span>
                <span>{n.text}</span>
                <span className="s">{n.agent ? `${n.agent} · ${word(n.state)}` : word(n.state)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {p.needsYou.length > 0 && (
        <Section name="Needs you">
          <ul className="need-list">
            {p.needsYou.map((n, i) => (
              <NeedEntry key={`${n.kind}:${n.task ?? ""}:${i}`} need={n} onAgent={p.onAgent} onTerminal={p.onTerminal} />
            ))}
          </ul>
        </Section>
      )}

      {p.outside.length > 0 && (
        <Section name="Outside the task">
          <ul className="pb-list">
            {p.outside.map((f) => (
              <li key={f} className="mono">
                {f}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {p.dropped.length > 0 && (
        <Section name="Dropped">
          <ul className="pb-list">
            {p.dropped.map((d) => (
              <li key={d.task} className="pb-row">
                <span className="id">{d.task}</span>
                <span>{d.text}</span>
                <span className="s">{d.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {p.agents.length > 0 && (
        <Section name="Agents">
          {p.agents.map((a) => (
            <div key={a.id} className="pb-agent" data-agent={a.id}>
              <button type="button" className="pb-agent-main" onClick={() => p.onAgent(a.id)}>
                <span>{a.role}</span>
                <span className="mono">{a.tool}</span>
                <span className="mono">{a.model}</span>
                <span>{word(a.status)}</span>
                <span className="mono">{a.task ?? "—"}</span>
                <span className="v">v{a.promptVersion}</span>
              </button>
              <button type="button" className="btn" onClick={() => p.onTerminal(a.id)}>
                Terminal
              </button>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
