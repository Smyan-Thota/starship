import type { ChatState, TaskView } from "../../../engine/src/types.ts";
import { TASK_STATE } from "../format.ts";

/** Task text with `code` spans, and no HTML. */
export function Inline({ text }: { text: string }) {
  const parts = text.split("`");
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : p))}</>;
}

export function taskStateText(t: TaskView): string {
  if (t.state === "verified" || t.state === "queued") return "";
  if (t.state === "blocked") return TASK_STATE.blocked;
  return t.agent ? `${t.agent} · ${TASK_STATE[t.state]}` : TASK_STATE[t.state];
}

export function Progress({ verified, total }: { verified: number; total: number }) {
  const pct = total > 0 ? Math.round((verified / total) * 100) : 0;
  return (
    <>
      <span>
        {verified} / {total}
      </span>
      <span className="bar" role="progressbar" aria-valuenow={verified} aria-valuemin={0} aria-valuemax={total}>
        <i style={{ width: `${pct}%` }} />
      </span>
    </>
  );
}

export function TasksError({ error }: { error: NonNullable<ChatState["tasksError"]> }) {
  return (
    <dl className="props" data-testid="tasks-error">
      <dt>File</dt>
      <dd className="mono">{error.file}</dd>
      <dt>Line</dt>
      <dd>{error.line}</dd>
      <dt>Reason</dt>
      <dd className="red">{error.reason}</dd>
    </dl>
  );
}

export function Tasks({ state }: { state: ChatState }) {
  const { tasks, tasksError, queue } = state;
  if (tasksError) {
    return (
      <>
        <h1>Tasks</h1>
        <TasksError error={tasksError} />
      </>
    );
  }
  if (!tasks) {
    return (
      <>
        <h1>Tasks</h1>
        <p className="mut">No tasks</p>
      </>
    );
  }
  const mine = queue.filter((q) => q.chat === state.chat.id);
  return (
    <>
      <h1>Tasks</h1>
      <dl className="props">
        <dt>Progress</dt>
        <dd>
          <Progress verified={tasks.verified} total={tasks.total} />
        </dd>
        {mine.length > 0 && (
          <>
            <dt>Run queue</dt>
            <dd>{mine.map((q) => `${q.task} · ${q.state}`).join(" · ")}</dd>
          </>
        )}
      </dl>
      {tasks.phases.map((ph) => (
        <section key={ph.n}>
          <div className="ph">
            Phase {ph.n} · {ph.title}
          </div>
          {ph.tasks.map((t) => {
            const verified = t.state === "verified";
            return (
              <div key={t.id} className={verified ? "tr done" : "tr"} data-task={t.id}>
                <span className={verified ? "box on" : "box"} aria-label={verified ? "verified" : "open"} role="img">
                  {verified ? "✓" : ""}
                </span>
                <span className="id">{t.id}</span>
                <span className="tx">
                  <Inline text={t.text} />
                </span>
                <span className="s">{taskStateText(t)}</span>
              </div>
            );
          })}
        </section>
      ))}
    </>
  );
}
