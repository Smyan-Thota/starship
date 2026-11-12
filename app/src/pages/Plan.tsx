import { useState } from "react";
import "./plan-build.css";

/** One line of the plan's TL;DR: a short label and a value taken from a plan file. */
export interface PlanLine {
  label: string;
  value: string;
  /** Path inside the feature folder. */
  file: string;
  /** The heading the line comes from, or null for the top of the file. */
  heading: string | null;
}

/** One thing the plan validator found. */
export interface PlanProblem {
  file: string;
  line: number | null;
  text: string;
}

export interface PlanWireframe {
  name: string;
  /** An artifact address, when the agent reported one. */
  link: string | null;
}

export interface PlanPageProps {
  title: string;
  lines: PlanLine[];
  /** Empty means the plan is valid. */
  problems: PlanProblem[];
  wireframes: PlanWireframe[];
  /** The plan files that exist. */
  files: string[];
  onOpenFile: (file: string, heading: string | null) => void;
  /** Opens the wireframe in the browser. Nothing renders in the window. */
  onOpenWireframe: (name: string) => void;
  /** null: the build started. A string: the refusal text of the engine. */
  onStartBuild: () => Promise<string | null>;
}

export function PlanPage({ title, lines, problems, wireframes, files, onOpenFile, onOpenWireframe, onStartBuild }: PlanPageProps) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const start = () => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    onStartBuild().then(
      (answer) => {
        setRefusal(answer);
        setBusy(false);
      },
      (err: unknown) => {
        setRefusal(err instanceof Error ? err.message : String(err));
        setBusy(false);
      },
    );
  };

  return (
    <>
      <h1>{title}</h1>
      <div>
        {lines.map((l) => (
          <button key={`${l.label}:${l.file}`} type="button" className="pb-line" data-line={l.label} onClick={() => onOpenFile(l.file, l.heading)}>
            <span className="k">{l.label}</span>
            <span className="v">{l.value}</span>
          </button>
        ))}
      </div>
      {files.length > 0 && (
        <>
          <h3>Files</h3>
          <ul className="pb-list">
            {files.map((f) => (
              <li key={f}>
                <button type="button" className="pb-item" onClick={() => onOpenFile(f, null)}>
                  <span className="name">{f}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {wireframes.length > 0 && (
        <>
          <h3>Wireframes</h3>
          <ul className="pb-list" aria-label="Wireframes">
            {wireframes.map((w) => (
              <li key={w.name}>
                <button type="button" className="pb-item" onClick={() => onOpenWireframe(w.name)}>
                  <span className="lk ext">{w.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {problems.length > 0 && (
        <>
          <h3>Problems</h3>
          <ul className="pb-list pb-problems" aria-label="Problems">
            {problems.map((p, i) => (
              <li key={`${p.file}:${p.line ?? ""}:${i}`}>
                <button type="button" className="pb-item" onClick={() => onOpenFile(p.file, null)}>
                  <span className="where">{p.line === null ? p.file : `${p.file}:${p.line}`}</span>
                  <span>{p.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="pb-actions">
        <button type="button" className="btn blue" disabled={busy} onClick={start}>
          Start build
        </button>
        {refusal !== null && (
          <span role="alert" className="red">
            {refusal}
          </span>
        )}
      </div>
    </>
  );
}
