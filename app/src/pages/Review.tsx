import { useState } from "react";
import { NeedEntry, type NeedItem } from "../components/NeedEntry.tsx";
import "./review-settings.css";

export type Severity = "high" | "medium" | "low";
export type FindingStatus = "open" | "disputed" | "accepted" | "rejected";
export type CardResult = "pass" | "fail" | "unclear";

export interface ReviewFinding {
  n: number;
  sev: Severity;
  reviewer: string;
  where: string;
  text: string;
  status: FindingStatus;
  dispute: { reviewer: string; why: string } | null;
}

export interface ReviewCard {
  id: string;
  title: string;
  criteria: string[];
  result: CardResult | null;
  note: string;
}

export interface ReviewFix {
  n: number;
  text: string;
  from: string;
}

export interface ReviewAgent {
  id: string;
  role: string;
  tool: string;
  model: string;
  status: string;
}

export interface ReviewPageProps {
  findings: ReviewFinding[];
  /** Reviewers that found nothing. */
  none: string[];
  cards: ReviewCard[];
  fixes: ReviewFix[];
  agents: ReviewAgent[];
  /** What waits for the owner. Hidden when empty. */
  needsYou: NeedItem[];
  onTerminal: (agentId: string) => void;
  onAgent: (agentId: string) => void;
  onOpenFile: (where: string) => void;
  /** null = sent. A string = the refusal text. */
  onSendFixes: () => Promise<string | null>;
}

const GROUPS: { status: FindingStatus; label: string }[] = [
  { status: "disputed", label: "Disputed" },
  { status: "open", label: "Open" },
  { status: "accepted", label: "Accepted" },
  { status: "rejected", label: "Rejected" },
];

function Finding({ f, onOpenFile }: { f: ReviewFinding; onOpenFile: (where: string) => void }) {
  return (
    <div className="rv-item" data-finding={f.n}>
      <div className="rv-head">
        <span className="rv-id">F{f.n}</span>
        <span className={`rv-sev ${f.sev}`}>{f.sev}</span>
        <span className="rv-tx">{f.text}</span>
      </div>
      <div className="rv-meta">
        <span>{f.reviewer}</span>
        <button type="button" className="lk mono" onClick={() => onOpenFile(f.where)}>
          {f.where}
        </button>
      </div>
      {f.dispute && (
        <div className="rv-dispute">
          <span>
            {f.dispute.reviewer}: {f.dispute.why}
          </span>
        </div>
      )}
    </div>
  );
}

function resultText(r: ReviewCard["result"]): string {
  return r ?? "not run";
}

export function ReviewPage({ findings, none, cards, fixes, agents, needsYou, onTerminal, onAgent, onOpenFile, onSendFixes }: ReviewPageProps) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setRefusal(null);
    try {
      setRefusal(await onSendFixes());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Review</h1>

      {needsYou.length > 0 && (
        <section className="rv-sec" aria-label="Needs you">
          <h2>Needs you</h2>
          <ul className="need-list">
            {needsYou.map((n, i) => (
              <NeedEntry key={`${n.kind}:${n.task ?? ""}:${i}`} need={n} onAgent={onAgent} onTerminal={onTerminal} />
            ))}
          </ul>
        </section>
      )}

      <section className="rv-sec">
        <h2>Findings</h2>
        {GROUPS.map((g) => {
          const items = findings.filter((f) => f.status === g.status);
          if (items.length === 0) return null;
          return (
            <div key={g.status} className="rv-group" data-group={g.status}>
              <div className="rv-gl">
                {g.label} · {items.length}
              </div>
              {items.map((f) => (
                <Finding key={f.n} f={f} onOpenFile={onOpenFile} />
              ))}
            </div>
          );
        })}
        {none.map((r) => (
          <p key={r} className="mut">
            {r}: no findings
          </p>
        ))}
      </section>

      <section className="rv-sec">
        <h2>Story cards</h2>
        {cards.map((c) => (
          <div key={c.id} className="rv-item" data-card={c.id}>
            <div className="rv-head">
              <span className="rv-id">{c.id}</span>
              <span className="rv-tx">{c.title}</span>
              <span className={`rv-res ${c.result ?? "none"}`}>{resultText(c.result)}</span>
            </div>
            {c.criteria.length > 0 && (
              <ul className="rv-crit">
                {c.criteria.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
            {c.note !== "" && <div className="rv-meta">{c.note}</div>}
          </div>
        ))}
      </section>

      <section className="rv-sec">
        <h2>Fixes</h2>
        {fixes.map((x) => (
          <div key={x.n} className="rv-fix" data-fix={x.n}>
            <span className="rv-id">X{x.n}</span>
            <span className="rv-tx">{x.text}</span>
            <span className="rv-from">{x.from}</span>
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn" disabled={busy || (fixes.length === 0 && !findings.some((f) => f.status === "disputed"))} onClick={send}>
            Send fixes
          </button>
        </div>
        {refusal !== null && (
          <div role="alert" className="err">
            {refusal}
          </div>
        )}
      </section>

      {agents.length > 0 && (
        <section className="rv-sec">
          <h2>Agents</h2>
          {agents.map((a) => (
            <div key={a.id} className="rv-agent" data-agent={a.id}>
              <button type="button" className="lk" onClick={() => onAgent(a.id)}>
                {a.role}
              </button>
              <span className="mut">
                {a.model ? `${a.tool} · ${a.model}` : a.tool}
              </span>
              <span className="rv-status">{a.status}</span>
              <button type="button" className="btn" onClick={() => onTerminal(a.id)}>
                Terminal
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
