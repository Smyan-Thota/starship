import { useEffect, useState, type ReactNode } from "react";
import "./review-settings.css";

export type SettingsTool = "claude" | "codex";
export type SettingsRoleKey = "admin" | "orchestrator" | "worker" | "reviewer1" | "reviewer2" | "cardRunner";

/** The shape of engine/src/config.ts `Config`. The page sends it back whole, so fields it does not edit stay as they were. */
export interface SettingsConfig {
  terminalApp: "iTerm" | "Terminal";
  portFrom: number;
  workers: number;
  maxWorkers: number;
  checkAttempts: number;
  checkTimeoutMin: number;
  maxHeavy: number;
  stallMin: number;
  contextRestartAt: number;
  switch: { enabled: boolean; at: number; from: SettingsTool; to: SettingsTool };
  roles: Record<SettingsRoleKey, { tool: SettingsTool; model: string }>;
}

export interface SettingsPageProps {
  config: SettingsConfig;
  /** null = saved. A string = the error text. */
  onSave: (config: SettingsConfig) => Promise<string | null>;
}

const ROLES: { key: SettingsRoleKey; label: string }[] = [
  { key: "admin", label: "Admin" },
  { key: "orchestrator", label: "Orchestrator" },
  { key: "worker", label: "Worker" },
  { key: "reviewer1", label: "Reviewer 1" },
  { key: "reviewer2", label: "Reviewer 2" },
  { key: "cardRunner", label: "Card runner" },
];

const TOOLS: { value: SettingsTool; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

type NumKey = "workers" | "checkAttempts" | "checkTimeoutMin" | "usage" | "context";

/** The ranges are the ones engine/src/config.ts enforces. Workers starts at 2: the owner asked for two to three. */
const NUMS: { key: NumKey; label: string; min: number; max: number }[] = [
  { key: "workers", label: "Workers per chat", min: 2, max: 3 },
  { key: "checkAttempts", label: "Check attempts", min: 1, max: 10 },
  { key: "checkTimeoutMin", label: "Check timeout (min)", min: 1, max: 240 },
  { key: "usage", label: "Usage threshold %", min: 1, max: 100 },
  { key: "context", label: "Context threshold %", min: 10, max: 100 },
];

function numbersOf(c: SettingsConfig): Record<NumKey, string> {
  return {
    workers: String(c.workers),
    checkAttempts: String(c.checkAttempts),
    checkTimeoutMin: String(c.checkTimeoutMin),
    usage: String(c.switch.at),
    context: String(c.contextRestartAt),
  };
}

function inRange(text: string, min: number, max: number): boolean {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
}

export function SettingsPage({ config, onSave }: SettingsPageProps) {
  const [base, setBase] = useState(config);
  const [roles, setRoles] = useState(config.roles);
  const [terminalApp, setTerminalApp] = useState(config.terminalApp);
  const [nums, setNums] = useState(numbersOf(config));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const configKey = JSON.stringify(config);
  useEffect(() => {
    setBase(config);
    setRoles(config.roles);
    setTerminalApp(config.terminalApp);
    setNums(numbersOf(config));
    // The props object is replaced on every read. Its content is the trigger.
  }, [configKey]);

  const allValid = NUMS.every((f) => inRange(nums[f.key], f.min, f.max));
  const next: SettingsConfig = {
    ...base,
    terminalApp,
    workers: Number(nums.workers),
    checkAttempts: Number(nums.checkAttempts),
    checkTimeoutMin: Number(nums.checkTimeoutMin),
    contextRestartAt: Number(nums.context),
    switch: { ...base.switch, at: Number(nums.usage) },
    roles,
  };
  const dirty = allValid && JSON.stringify(next) !== JSON.stringify(base);

  async function save() {
    if (!allValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onSave(next);
      if (err === null) setBase(next);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <table className="st-roles">
        <tbody>
          {ROLES.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>
                <select
                  aria-label={`${r.label} tool`}
                  value={roles[r.key].tool}
                  onChange={(e) => {
                    const tool = e.target.value === "codex" ? "codex" : "claude";
                    setRoles({ ...roles, [r.key]: { ...roles[r.key], tool } });
                  }}
                >
                  {TOOLS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="text"
                  aria-label={`${r.label} model`}
                  value={roles[r.key].model}
                  onChange={(e) => setRoles({ ...roles, [r.key]: { ...roles[r.key], model: e.target.value } })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="props st-fields">
        <dt>Terminal app</dt>
        <dd>
          <select aria-label="Terminal app" value={terminalApp} onChange={(e) => setTerminalApp(e.target.value === "Terminal" ? "Terminal" : "iTerm")}>
            <option value="iTerm">iTerm</option>
            <option value="Terminal">Terminal</option>
          </select>
        </dd>
        {NUMS.map((f) => {
          const ok = inRange(nums[f.key], f.min, f.max);
          return (
            <FragmentRow key={f.key} label={f.label}>
              <input
                type="number"
                aria-label={f.label}
                aria-invalid={!ok}
                min={f.min}
                max={f.max}
                step={1}
                value={nums[f.key]}
                onChange={(e) => setNums({ ...nums, [f.key]: e.target.value })}
              />
              {!ok && (
                <span className="err">
                  {f.min}–{f.max}
                </span>
              )}
            </FragmentRow>
          );
        })}
      </dl>

      <div className="row">
        <button type="button" className="btn" disabled={!dirty || busy} onClick={save}>
          Save
        </button>
      </div>
      {error !== null && (
        <div role="alert" className="err">
          {error}
        </div>
      )}
    </>
  );
}

function FragmentRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
