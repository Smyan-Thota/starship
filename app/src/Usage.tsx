import { useEffect, useState } from "react";
import "./pages/review-settings.css";

export interface UsageWindowBar {
  name: string;
  usedPct: number | null;
  /** Epoch milliseconds, on the same clock as `now`. */
  resetsAt: number | null;
}

export interface UsageTool {
  tool: "claude" | "codex";
  windows: UsageWindowBar[];
  contextPct: number | null;
}

export interface UsageMove {
  at: string;
  agent: string;
  from: string;
  to: string;
}

export interface UsageBarsProps {
  tools: UsageTool[];
  threshold: number;
  switchOn: boolean;
  /** Epoch milliseconds. */
  now: number;
  moves: UsageMove[];
  onSwitch: (on: boolean) => void;
  onThreshold: (pct: number) => void;
}

const TOOL_NAME = { claude: "Claude", codex: "Codex" } as const;
const MIN = 50;
const MAX = 100;

/** A window whose reset time has passed counts as 0. Unknown stays null. */
export function effectivePct(w: UsageWindowBar, now: number): number | null {
  if (w.resetsAt !== null && w.resetsAt <= now) return 0;
  return w.usedPct;
}

function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "";
  const min = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
  if (min <= 0) return "";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function Bar({ tool, w, threshold, now }: { tool: UsageTool["tool"]; w: UsageWindowBar; threshold: number; now: number }) {
  const pct = effectivePct(w, now);
  const hot = pct !== null && pct >= threshold;
  const reset = resetText(w.resetsAt, now);
  return (
    <div className="us-bar" data-bar={`${tool}|${w.name}`}>
      <span className="us-t">{TOOL_NAME[tool]}</span>
      <span className="us-w">{w.name}</span>
      <span className="us-p">{pct === null ? "unknown" : `${Math.round(pct)}%`}</span>
      <span className="us-r">{reset}</span>
      <span className="us-track" role="progressbar" aria-label={`${TOOL_NAME[tool]} ${w.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        {pct !== null && <i className={hot ? "fill hot" : "fill"} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
        <b className="mark" style={{ left: `${threshold}%` }} />
      </span>
    </div>
  );
}

export function UsageBars({ tools, threshold, switchOn, now, moves, onSwitch, onThreshold }: UsageBarsProps) {
  const [draft, setDraft] = useState(String(threshold));
  useEffect(() => setDraft(String(threshold)), [threshold]);
  const n = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(n) && n >= MIN && n <= MAX;

  return (
    <div className="us">
      {tools.map((t) => (
        <div key={t.tool} className="us-tool">
          {t.windows.map((w) => (
            <Bar key={w.name} tool={t.tool} w={w} threshold={threshold} now={now} />
          ))}
          {t.contextPct !== null && (
            <div className="us-ctx" data-context={t.tool}>
              <span className="us-t">{TOOL_NAME[t.tool]}</span>
              <span className="us-w">context</span>
              <span className="us-p">{`${Math.round(t.contextPct)}%`}</span>
            </div>
          )}
        </div>
      ))}
      <div className="us-set">
        <label>
          <input type="checkbox" checked={switchOn} onChange={(e) => onSwitch(e.target.checked)} />
          Switch
        </label>
        <label>
          Threshold %
          <input
            type="number"
            aria-label="Threshold %"
            min={MIN}
            max={MAX}
            step={1}
            value={draft}
            aria-invalid={!valid}
            onChange={(e) => {
              const v = e.target.value;
              setDraft(v);
              const x = Number(v);
              if (v.trim() !== "" && Number.isInteger(x) && x >= MIN && x <= MAX) onThreshold(x);
            }}
          />
        </label>
        {!valid && <span className="err">{MIN}–{MAX}</span>}
      </div>
      {moves.length > 0 && (
        <div className="us-moves">
          {moves.map((m, i) => (
            <div key={i} className="mono">{`${m.at} ${m.agent} ${m.from} → ${m.to}`}</div>
          ))}
        </div>
      )}
    </div>
  );
}
