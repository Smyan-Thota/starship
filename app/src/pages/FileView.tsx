import { useEffect, useState } from "react";
import type { FileBody, FileInfo } from "../../../engine/src/types.ts";
import { fileKind, isHtml, isMarkdown, size } from "../format.ts";
import { Markdown } from "./Markdown.tsx";

export interface FileViewProps {
  path: string;
  /** The file's entry in the list, when known. */
  info?: FileInfo;
  loadFile: (path: string) => Promise<FileBody>;
  onOpenInBrowser: (path: string) => void;
  /** Hide the path row, for a document tab. */
  bare?: boolean;
  /** A file of the worktree, not a plan file: read-only text, whatever its extension. */
  plain?: boolean;
}

type Load = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "done"; body: FileBody };

function OpenInBrowser({ path, onOpenInBrowser }: { path: string; onOpenInBrowser: (path: string) => void }) {
  return (
    <p>
      <button type="button" className="lk" onClick={() => onOpenInBrowser(path)}>
        Open ↗
      </button>
    </p>
  );
}

/** Name, kind and size, and no content. For a binary file and a file over 1 MB. */
export function FileFacts({ info }: { info: FileInfo }) {
  return (
    <dl className="props" data-testid="file-facts">
      <dt>Name</dt>
      <dd className="mono">{info.path}</dd>
      <dt>Kind</dt>
      <dd>{fileKind(info)}</dd>
      <dt>Size</dt>
      <dd>{size(info.size)}</dd>
    </dl>
  );
}

export function FileView({ path, info, loadFile, onOpenInBrowser, bare, plain }: FileViewProps) {
  const html = info?.html === true || isHtml(path);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (html) return;
    let live = true;
    setLoad({ kind: "loading" });
    setRaw(false);
    loadFile(path).then(
      (body) => live && setLoad({ kind: "done", body }),
      (e: unknown) => live && setLoad({ kind: "error", reason: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [path, html, loadFile]);

  // An .html file never renders in the window, and is never loaded.
  if (html) return <OpenInBrowser path={path} onOpenInBrowser={onOpenInBrowser} />;
  if (load.kind === "loading") return <p className="mut">Loading</p>;
  if (load.kind === "error") return <p className="red">{load.reason}</p>;

  const { body } = load;
  if (body.open) return <OpenInBrowser path={path} onOpenInBrowser={onOpenInBrowser} />;
  if (body.text === null) return <FileFacts info={body.info} />;

  const md = !plain && isMarkdown(path);
  return (
    <>
      {(!bare || md) && (
        <div className="row head">
          <span className="mono mut">{bare ? "" : path}</span>
          {md && (
            <button type="button" className="lk" onClick={() => setRaw((r) => !r)}>
              {raw ? "Rendered" : "Raw"}
            </button>
          )}
        </div>
      )}
      {md && !raw ? <Markdown text={body.text} /> : <pre className="pre">{body.text}</pre>}
    </>
  );
}
