/**
 * The window on live data: App, fed by the data layer in data.ts.
 */
import { useEffect, useMemo } from "react";
import { liveActions } from "./actions.ts";
import { App } from "./App.tsx";
import { CONN_LABEL, type LiveData, useLive } from "./data.ts";

export function Live({ live }: { live: LiveData }) {
  const snap = useLive(live);
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, [live]);
  const actions = useMemo(() => liveActions(live), [live]);

  return (
    <App
      chats={snap.chats}
      state={snap.state}
      repos={snap.repos}
      config={snap.config}
      usage={snap.usage}
      status={CONN_LABEL[snap.conn]}
      draft={live.draft(snap.state?.chat.id ?? null)}
      actions={actions}
    />
  );
}
