import type { ChatState } from "../../../engine/src/types.ts";
import { isHtml, size } from "../format.ts";

export interface FilesProps {
  state: ChatState;
  onOpenFile: (path: string) => void;
  onOpenInBrowser: (path: string) => void;
}

export function Files({ state, onOpenFile, onOpenInBrowser }: FilesProps) {
  const { chat, files } = state;
  return (
    <>
      <h1>Files</h1>
      {chat.slug && <p className="mono mut">docs/features/{chat.slug}/</p>}
      {state.folderMissing && <p className="red">Folder missing</p>}
      {files.length === 0 && <p className="mut">No files</p>}
      {files.map((f) =>
        f.html || isHtml(f.path) ? (
          // An .html file is never loaded into the window.
          <button key={f.path} type="button" className="fl" data-path={f.path} onClick={() => onOpenInBrowser(f.path)}>
            <span>{f.path} ↗</span>
            <small>browser</small>
          </button>
        ) : (
          <button key={f.path} type="button" className="fl" data-path={f.path} onClick={() => onOpenFile(f.path)}>
            <span>{f.path}</span>
            <small>{size(f.size)}</small>
          </button>
        ),
      )}
    </>
  );
}
