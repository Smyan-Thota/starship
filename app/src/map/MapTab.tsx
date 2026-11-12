import { useEffect, useState } from "react";
import type { AppActions, MapAnswer } from "../actions.ts";
import { MapPage } from "./MapPage.tsx";

export interface MapTabProps {
  repo: string;
  chat: string;
  /** Changes when the map or the chat's overlay changed on disk, so the map is read again. */
  version: string;
  actions: Pick<AppActions, "loadMap" | "buildMap">;
  /** The open flow. Kept by the caller, so it stays when the page is left and opened again. */
  flow: string;
  onFlow: (id: string) => void;
}

type Load = { kind: "loading" } | { kind: "failed"; text: string } | { kind: "done"; answer: MapAnswer };

function Errors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="pb-list" aria-label="Errors">
      {errors.map((e, i) => (
        <li key={i} className="red">
          {e}
        </li>
      ))}
    </ul>
  );
}

/** The map of the chat's repo, with the overlay of this chat. With no map, a button builds it. */
export function MapTab({ repo, chat, version, actions, flow, onFlow }: MapTabProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [again, setAgain] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    actions.loadMap(repo, chat).then(
      (answer) => live && setLoad({ kind: "done", answer }),
      (e: unknown) => live && setLoad({ kind: "failed", text: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [actions, repo, chat, version, again]);

  const build = () => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    actions.buildMap(repo).then(
      (err) => {
        setRefusal(err);
        setBusy(false);
        if (err === null) setAgain((n) => n + 1);
      },
      (e: unknown) => {
        setRefusal(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };

  if (load.kind === "loading") return <p className="mut">Loading</p>;
  if (load.kind === "failed") return <p className="red">{load.text}</p>;
  const { map, errors } = load.answer;
  if (map) {
    return (
      <>
        <MapPage map={map} flow={flow} onFlow={onFlow} />
        <Errors errors={errors} />
      </>
    );
  }
  return (
    <>
      <h1>Map</h1>
      <Errors errors={errors} />
      <div className="pb-actions">
        <button type="button" className="btn blue" disabled={busy} onClick={build}>
          Build map
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
