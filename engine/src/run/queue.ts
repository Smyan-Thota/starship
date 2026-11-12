/**
 * The run queue: the one line in which checks wait.
 *
 * First in, first out. One heavy job runs at a time on the whole Mac: the queue holds the heavy slot in
 * process, and a lock folder in `lockDir` keeps a second engine process out. A light job runs next to
 * anything, except a job whose name makes a conflict pair with a running or an earlier waiting job.
 * Each job is `sh -c <cmd>` in its own process group, so a timeout or a drop kills everything it started.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Job {
  id: string;
  chat: string;
  /** Names a command for conflict pairs. */
  name?: string;
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
  heavy: boolean;
  logPath: string;
}

export interface CheckResult {
  id: string;
  outcome: "pass" | "fail" | "timeout" | "dropped";
  /** null when a signal ended the job, or when it never ran. */
  exit: number | null;
  durationMs: number;
  logPath: string;
}

export interface QueueOptions {
  lockDir: string;
  /** Default 15 minutes. */
  timeoutMs?: number;
  conflicts?: [string, string][];
  onChange?: () => void;
}

export interface Pending {
  id: string;
  chat: string;
  state: "queued" | "running";
}

interface Entry {
  job: Job;
  resolve: (r: CheckResult) => void;
  /** Set once the job runs. */
  kill?: () => void;
  dropped: boolean;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const LOCK_POLL_MS = 50;
/** A lock folder with no readable pid is held, unless it is older than this. */
const UNREADABLE_LOCK_MS = 10_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and is not ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The machine-wide heavy slot: a folder made with an atomic mkdir, holding the pid of its owner. */
class HeavyLock {
  private readonly dir: string;
  held = false;

  constructor(lockDir: string) {
    this.dir = join(lockDir, "heavy.lock");
    mkdirSync(lockDir, { recursive: true });
  }

  private stale(): boolean {
    try {
      const pid = Number.parseInt(readFileSync(join(this.dir, "pid"), "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
    } catch {
      // The pid file may not be written yet, or the folder is gone.
    }
    try {
      return Date.now() - statSync(this.dir).mtimeMs > UNREADABLE_LOCK_MS;
    } catch {
      return true;
    }
  }

  tryTake(): boolean {
    for (let i = 0; i < 3; i++) {
      try {
        mkdirSync(this.dir);
        writeFileSync(join(this.dir, "pid"), `${process.pid}\n`);
        this.held = true;
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      if (!this.stale()) return false;
      // Move the stale folder away first: a rename has one winner when two processes race to clean up.
      const away = `${this.dir}.stale-${process.pid}-${Date.now()}-${i}`;
      try {
        renameSync(this.dir, away);
        rmSync(away, { recursive: true, force: true });
      } catch {
        // Someone else cleaned it. Try the mkdir again.
      }
    }
    return false;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export class RunQueue {
  private readonly timeoutMs: number;
  private readonly conflicts: [string, string][];
  private readonly onChange?: () => void;
  private readonly lock: HeavyLock;
  private readonly waiting: Entry[] = [];
  private readonly running: Entry[] = [];
  private poll: ReturnType<typeof setTimeout> | undefined;
  private idleWaiters: (() => void)[] = [];

  constructor(o: QueueOptions) {
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.conflicts = o.conflicts ?? [];
    this.onChange = o.onChange;
    this.lock = new HeavyLock(o.lockDir);
  }

  enqueue(job: Job): Promise<CheckResult> {
    return new Promise((resolve) => {
      this.waiting.push({ job, resolve, dropped: false });
      this.changed();
      this.pump();
    });
  }

  /** Removes the chat's queued jobs and kills its running job. Each ends as `dropped`. Returns how many. */
  drop(chat: string): number {
    let n = 0;
    for (const e of [...this.waiting]) {
      if (e.job.chat !== chat) continue;
      this.waiting.splice(this.waiting.indexOf(e), 1);
      e.dropped = true;
      e.resolve({ id: e.job.id, outcome: "dropped", exit: null, durationMs: 0, logPath: e.job.logPath });
      n++;
    }
    for (const e of this.running) {
      if (e.job.chat !== chat || e.dropped) continue;
      e.dropped = true;
      e.kill?.();
      n++;
    }
    if (n > 0) {
      this.changed();
      this.settle();
    }
    return n;
  }

  pending(): Pending[] {
    return [
      ...this.running.map((e): Pending => ({ id: e.job.id, chat: e.job.chat, state: "running" })),
      ...this.waiting.map((e): Pending => ({ id: e.job.id, chat: e.job.chat, state: "queued" })),
    ];
  }

  /** Resolves when nothing is queued and nothing runs. */
  idle(): Promise<void> {
    if (this.waiting.length === 0 && this.running.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private conflict(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined || b === undefined) return false;
    return this.conflicts.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch {
      // A listener must not break the queue.
    }
  }

  private settle(): void {
    if (this.waiting.length > 0 || this.running.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Starts every waiting job that may start now, in order. */
  private pump(): void {
    let heavyHeld = this.running.some((e) => e.job.heavy);
    let heavyLockBusy = false;
    const skipped: Entry[] = [];
    for (const e of [...this.waiting]) {
      const j = e.job;
      const blockedByEarlier = skipped.some((s) => (j.heavy && s.job.heavy) || this.conflict(s.job.name, j.name));
      const blocked =
        blockedByEarlier ||
        this.running.some((r) => this.conflict(r.job.name, j.name)) ||
        (j.heavy && heavyHeld);
      if (blocked) {
        skipped.push(e);
        continue;
      }
      if (j.heavy) {
        if (!this.lock.tryTake()) {
          heavyLockBusy = true;
          skipped.push(e);
          continue;
        }
        heavyHeld = true;
      }
      this.waiting.splice(this.waiting.indexOf(e), 1);
      this.start(e);
    }
    if (heavyLockBusy && !this.poll) {
      this.poll = setTimeout(() => {
        this.poll = undefined;
        this.pump();
      }, LOCK_POLL_MS);
    }
  }

  private start(e: Entry): void {
    this.running.push(e);
    this.changed();
    const j = e.job;
    const t0 = Date.now();
    let timedOut = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let logFd: number | undefined;

    const finish = (exit: number | null): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (logFd !== undefined) closeSync(logFd);
      this.running.splice(this.running.indexOf(e), 1);
      if (j.heavy) this.lock.release();
      const outcome: CheckResult["outcome"] = e.dropped ? "dropped" : timedOut ? "timeout" : exit === 0 ? "pass" : "fail";
      e.resolve({ id: j.id, outcome, exit: outcome === "dropped" || outcome === "timeout" ? null : exit, durationMs: Date.now() - t0, logPath: j.logPath });
      this.changed();
      this.pump();
      this.settle();
    };

    try {
      mkdirSync(dirname(j.logPath), { recursive: true });
      logFd = openSync(j.logPath, "a");
      const child = spawn("sh", ["-c", j.cmd], {
        cwd: j.cwd,
        env: { ...process.env, ...j.env },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      const pid = child.pid;
      const killGroup = (): void => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      };
      e.kill = killGroup;
      timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, this.timeoutMs);
      child.on("error", () => finish(null));
      child.on("exit", (code) => {
        // A job that was killed leaves no child behind.
        if (timedOut || e.dropped) killGroup();
        finish(code);
      });
    } catch {
      finish(null);
    }
  }
}

/** The last `n` lines of a file. An empty string when the file is missing. */
export function tailLines(path: string, n = 200): string {
  if (!existsSync(path)) return "";
  const CHUNK = 4 * 1024 * 1024;
  let text: string;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, CHUNK);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    text = buf.toString("utf8");
    // A cut-off first line is not a whole line.
    if (size > len) text = text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}
