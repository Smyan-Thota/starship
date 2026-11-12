import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AgentStatus, MessageState, MessageView, NeedView, Note, Question } from "../../../engine/src/types.ts";
import { NeedEntry } from "../components/NeedEntry.tsx";
import { AGENT_STATUS, agentDot, NOTE_TARGET } from "../format.ts";
import "./chat.css";

export interface ChatPaneProps {
  messages: MessageView[];
  notes: Note[];
  /** Questions from workers. Only the open ones show. */
  questions: Question[];
  /** What waits for the owner. An entry that names an agent opens that agent's page and has a Terminal button. */
  needs: NeedView[];
  /** Opens the page of an agent. */
  onAgent: (id: string) => void;
  /** Opens the terminal of an agent. */
  onAgentTerminal: (id: string) => void;
  /** The admin agent's status. null when the chat has no admin agent: the header shows nothing. */
  adminStatus: AgentStatus | null;
  /** Unsent text from before, put in the input. */
  draft: string;
  /** Called on every change to the input, and with "" after a send. */
  onDraft: (text: string) => void;
  /** Resolves true when the engine has the text. False keeps the text in the input. */
  onSend: (text: string) => Promise<boolean>;
  onRetry: (messageId: string) => void;
  /** Resolves null when the note is undone, or the refusal label, such as "Being read" or "Already read". */
  onUndo: (noteNumber: number) => Promise<string | null>;
  /** Opens the admin agent's terminal. */
  onTerminal: () => void;
}

/** Only the states that need a word. `sent` and `answered` show none. */
const STATE_WORD: Partial<Record<MessageState, string>> = {
  queued: "Queued",
  notSent: "Not sent",
  interrupted: "Interrupted",
};

const CAN_RETRY: MessageState[] = ["notSent", "interrupted"];

function noteStatus(n: Note): string {
  switch (n.status) {
    case "queued":
      return "Queued";
    case "held":
      return "Held";
    case "read":
      return n.readAt ? `Read ${n.readAt}` : "Read";
    case "undone":
      return "Undone";
  }
}

function NoteBlock({ note, refusal, busy, onUndo }: { note: Note; refusal: string | undefined; busy: boolean; onUndo: (n: number) => void }) {
  const canUndo = note.status === "queued" || note.status === "held";
  return (
    <div className="note" data-note={note.n}>
      {note.said && <div className="cp-said">You: {note.said}</div>}
      <div className="to">→ {NOTE_TARGET[note.to]}</div>
      <div>{note.note}</div>
      <div className="ns">
        {noteStatus(note)}
        {canUndo && (
          <button type="button" className="cp-act" disabled={busy} onClick={() => onUndo(note.n)}>
            Undo
          </button>
        )}
        {refusal && <span className="cp-refuse bad">{refusal}</span>}
      </div>
    </div>
  );
}

interface MessageProps {
  m: MessageView;
  notes: Note[];
  refusals: Record<number, string>;
  busy: number | null;
  onRetry: (id: string) => void;
  onUndo: (n: number) => void;
}

function Message({ m, notes, refusals, busy, onRetry, onUndo }: MessageProps) {
  if (m.who === "system") {
    return (
      <div className="m sys" data-message={m.id}>
        {m.at} · {m.text}
      </div>
    );
  }
  const note = m.note === undefined ? undefined : notes.find((n) => n.n === m.note);
  const word = m.state ? STATE_WORD[m.state] : undefined;
  const done = m.who === "admin" && !m.text;
  return (
    <div className="m" data-message={m.id} data-state={m.state}>
      <div className="w">
        <b>{m.who === "you" ? "You" : "Admin"}</b>
        {m.at}
        {m.fromTerminal && <span> · from terminal</span>}
        {word && <span className={m.state === "queued" ? "st" : "st bad"}>{word}</span>}
        {m.state && CAN_RETRY.includes(m.state) && (
          <button type="button" className="cp-act" onClick={() => onRetry(m.id)}>
            Retry
          </button>
        )}
      </div>
      {done && <div className="cp-done">Done</div>}
      {m.text && <div>{m.text}</div>}
      {m.files && m.files.length > 0 && <div className="fs">{m.files.join(" · ")}</div>}
      {note && <NoteBlock note={note} refusal={refusals[note.n]} busy={busy === note.n} onUndo={onUndo} />}
    </div>
  );
}

export function ChatPane({ messages, notes, questions, needs, adminStatus, draft, onDraft, onSend, onRetry, onUndo, onTerminal, onAgent, onAgentTerminal }: ChatPaneProps) {
  const [text, setTextState] = useState(draft);
  const current = useRef(text);
  const sending = useRef(false);
  const [notSent, setNotSent] = useState(false);
  const [refusals, setRefusals] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const setText = (v: string) => {
    current.current = v;
    setTextState(v);
  };

  // A new draft from the parent replaces the input, unless it is what the input already holds.
  useEffect(() => {
    if (draft !== current.current) {
      current.current = draft;
      setTextState(draft);
    }
  }, [draft]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const typed = text;
    const v = typed.trim();
    if (!v || sending.current) return;
    sending.current = true;
    setNotSent(false);
    onSend(v).then(
      (ok) => {
        sending.current = false;
        setNotSent(!ok);
        // Edge A14: the text leaves the input only when the engine has it, and only if the owner has not typed more.
        if (ok && current.current === typed) {
          setText("");
          onDraft("");
        }
      },
      () => {
        sending.current = false;
        setNotSent(true);
      },
    );
  };

  const undo = (n: number) => {
    setBusy(n);
    setRefusals(({ [n]: _gone, ...rest }) => rest);
    onUndo(n).then(
      (label) => {
        setBusy(null);
        if (label) setRefusals((r) => ({ ...r, [n]: label }));
      },
      () => setBusy(null),
    );
  };

  const open = questions.filter((q) => q.status === "open");
  // The engine does not link a note to a message. A note that no message carries shows after the messages.
  const carried = new Set(messages.flatMap((m) => (m.note === undefined ? [] : [m.note])));
  const loose = notes.filter((n) => !carried.has(n.n));
  // An open question shows as its own block. Its needs-you entry would say the same again.
  const rest = needs.filter((n) => !(n.kind === "question" && open.some((q) => q.agent === n.agent && q.question === n.text)));
  // The admin agent's own entry says more than the line that follows.
  const adminNamed = needs.some((n) => n.agent === "admin");

  return (
    <section className="chat" aria-label="Admin chat">
      {adminStatus !== null && (
        <div className="ch">
          <span className="ag" style={{ marginLeft: -8 }}>
            <span className={`dot ${agentDot(adminStatus)}`.trim()} />
            Admin
          </span>
          <span className="mut">{AGENT_STATUS[adminStatus]}</span>
        </div>
      )}
      <div className="msgs" aria-live="polite">
        {messages.map((m) => (
          <Message key={m.id} m={m} notes={notes} refusals={refusals} busy={busy} onRetry={onRetry} onUndo={undo} />
        ))}
        {loose.map((n) => (
          <div key={`note-${n.n}`} className="m" data-loose-note={n.n}>
            <NoteBlock note={n} refusal={refusals[n.n]} busy={busy === n.n} onUndo={undo} />
          </div>
        ))}
        {open.map((q) => (
          <div key={q.n} className="cp-q" data-question={q.n}>
            <button type="button" className="who lk" onClick={() => onAgent(q.agent)}>
              {q.agent} · {q.task}
            </button>
            <div>{q.question}</div>
            <button type="button" className="btn" onClick={() => onAgentTerminal(q.agent)}>
              Terminal
            </button>
          </div>
        ))}
      </div>
      {rest.length > 0 && (
        <ul className="cp-needs need-list" aria-label="Needs you">
          {rest.map((n, i) => (
            <NeedEntry key={`${n.kind}:${n.task ?? ""}:${i}`} need={n} onAgent={onAgent} onTerminal={onAgentTerminal} />
          ))}
        </ul>
      )}
      {adminStatus === "needsYou" && !adminNamed && (
        <div className="cp-need">
          <span>Admin needs you</span>
          <button type="button" className="btn" onClick={onTerminal}>
            Terminal
          </button>
        </div>
      )}
      <form className="form" noValidate onSubmit={submit}>
        <div className="inp">
          <input
            autoComplete="off"
            aria-label="Message"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onDraft(e.target.value);
            }}
          />
          <button className="snd" type="submit" aria-label="Send" disabled={!text.trim()}>
            ↑
          </button>
        </div>
        {notSent && (
          <p className="err" role="status">
            Not sent
          </p>
        )}
      </form>
    </section>
  );
}
