import { type FormEvent, useRef, useState } from "react";
import "../chat/newchat.css";

export interface NewChatInput {
  title: string;
  repo: string | null;
  feature: string | null;
}

export interface NewChatProps {
  repos: { name: string; path: string }[];
  /** Resolves null when the chat is created, or the error text to show. */
  onCreate: (input: NewChatInput) => Promise<string | null>;
  /** Resolves null when the repo is added, or the error text to show. */
  onAddRepo: (path: string) => Promise<string | null>;
  onCancel: () => void;
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Failed";
}

export function NewChat({ repos, onCreate, onAddRepo, onCancel }: NewChatProps) {
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [feature, setFeature] = useState("");
  const [path, setPath] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const running = useRef(false);

  const canCreate = title.trim() !== "" && !busy;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || running.current) return;
    running.current = true;
    setBusy(true);
    setCreateError(null);
    const slug = feature.trim();
    try {
      const err = await onCreate({ title: t, repo: repo || null, feature: repo && slug ? slug : null });
      setCreateError(err);
    } catch (x) {
      setCreateError(errorText(x));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const addRepo = async () => {
    const p = path.trim();
    if (!p || adding) return;
    setAdding(true);
    setRepoError(null);
    try {
      const err = await onAddRepo(p);
      setRepoError(err);
      if (err === null) setPath("");
    } catch (x) {
      setRepoError(errorText(x));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="nc">
      <h1>New chat</h1>
      <form className="nc" noValidate onSubmit={submit}>
        <label className="nc-field">
          Title
          <input required value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="nc-field">
          Repo
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">No repo</option>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="nc-field">
          Feature folder
          <input value={feature} disabled={!repo} autoComplete="off" onChange={(e) => setFeature(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="btn blue" disabled={!canCreate}>
            Create
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
        {createError !== null && (
          <p className="nc-err" role="alert">
            {createError}
          </p>
        )}
      </form>
      <div className="nc-row">
        <label className="nc-field">
          Repo path
          <input
            value={path}
            autoComplete="off"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addRepo();
              }
            }}
          />
        </label>
        <button type="button" className="btn" disabled={!path.trim() || adding} onClick={() => void addRepo()}>
          Add repo
        </button>
      </div>
      {repoError !== null && (
        <p className="nc-err" role="alert">
          {repoError}
        </p>
      )}
    </div>
  );
}
