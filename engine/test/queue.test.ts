import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunQueue, tailLines, type CheckResult, type Job } from "../src/run/queue.ts";
import { drop, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => {
  dir = tempDir("starship-queue-");
});
afterEach(() => drop(dir));

let counter = 0;
function job(over: Partial<Job> & { cmd: string }): Job {
  counter++;
  return { id: `j${counter}`, chat: "chat-a", cwd: dir, heavy: true, logPath: join(dir, "logs", `j${counter}.log`), ...over };
}

const trace = () => join(dir, "trace");
/** A command that writes "start X", waits, then writes "end X" to the shared trace file. */
const traced = (label: string, secs = "0.2") => `echo "start ${label}" >> '${trace()}'; sleep ${secs}; echo "end ${label}" >> '${trace()}'`;
const lines = (): string[] => (existsSync(trace()) ? readFileSync(trace(), "utf8").trim().split("\n") : []);
const queue = (o: Partial<ConstructorParameters<typeof RunQueue>[0]> = {}) => new RunQueue({ lockDir: join(dir, "lock"), ...o });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("run queue", () => {
  test("exit 0 is pass, anything else is fail, and the result names the job and its log", async () => {
    const q = queue();
    const ok = job({ cmd: "echo x" });
    const bad = job({ cmd: "exit 3" });
    const [a, b] = await Promise.all([q.enqueue(ok), q.enqueue(bad)]);
    expect(a).toMatchObject({ id: ok.id, outcome: "pass", exit: 0, logPath: ok.logPath });
    expect(b).toMatchObject({ id: bad.id, outcome: "fail", exit: 3 });
    expect(a.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("stdout and stderr are appended to the log, in the job's cwd and env", async () => {
    const q = queue();
    const sub = join(dir, "work");
    mkdirSync(sub);
    const logPath = join(dir, "logs", "one.log");
    mkdirSync(join(dir, "logs"));
    writeFileSync(logPath, "before\n");
    await q.enqueue(job({ cmd: "echo out; echo err 1>&2; pwd; echo $MARK", cwd: sub, env: { MARK: "hello" }, logPath }));
    expect(readFileSync(logPath, "utf8")).toBe(`before\nout\nerr\n${sub}\nhello\n`);
  });

  test("a job whose folder is missing fails and the queue goes on", async () => {
    const q = queue();
    const r = await q.enqueue(job({ cmd: "echo x", cwd: join(dir, "nope") }));
    expect(r.outcome).toBe("fail");
    expect((await q.enqueue(job({ cmd: "echo y" }))).outcome).toBe("pass");
  });

  test("F1: two chats queue heavy checks: first in, first out, one runs at a time", async () => {
    const q = queue();
    const done: string[] = [];
    const mk = (label: string, chat: string) => q.enqueue(job({ chat, cmd: traced(label, "0.15") })).then(() => done.push(label));
    await Promise.all([mk("A", "chat-a"), mk("B", "chat-b"), mk("C", "chat-a")]);
    expect(lines()).toEqual(["start A", "end A", "start B", "end B", "start C", "end C"]);
    expect(done).toEqual(["A", "B", "C"]);
  });

  test("F1: the queue lists what runs and what waits, in order", async () => {
    let changes = 0;
    const q = queue({ onChange: () => changes++ });
    const a = job({ cmd: "sleep 0.3" });
    const b = job({ chat: "chat-b", cmd: "echo b" });
    const pa = q.enqueue(a);
    const pb = q.enqueue(b);
    expect(q.pending()).toEqual([
      { id: a.id, chat: "chat-a", state: "running" },
      { id: b.id, chat: "chat-b", state: "queued" },
    ]);
    await Promise.all([pa, pb]);
    await q.idle();
    expect(q.pending()).toEqual([]);
    expect(changes).toBeGreaterThanOrEqual(4);
  });

  test("F1: idle() resolves at once when nothing is queued", async () => {
    await queue().idle();
  });

  test("F1: two engine processes never run two heavy jobs: a second queue on the same lock folder waits", async () => {
    const q1 = queue();
    const q2 = queue();
    await Promise.all([q1.enqueue(job({ cmd: traced("P1", "0.25") })), q2.enqueue(job({ cmd: traced("P2", "0.1") }))]);
    const l = lines();
    expect(l).toHaveLength(4);
    expect((l[0] ?? "").replace("start", "end")).toBe(l[1] ?? "");
    expect((l[2] ?? "").replace("start", "end")).toBe(l[3] ?? "");
    expect(existsSync(join(dir, "lock", "heavy.lock"))).toBe(false);
  });

  test("F1: the lock folder holds the pid of the process that runs the heavy job", async () => {
    const q = queue();
    const p = q.enqueue(job({ cmd: "sleep 0.3" }));
    await sleep(100);
    expect(readFileSync(join(dir, "lock", "heavy.lock", "pid"), "utf8").trim()).toBe(String(process.pid));
    await p;
    expect(existsSync(join(dir, "lock", "heavy.lock"))).toBe(false);
  });

  test("F1: a lock whose pid is dead is stale and is taken", async () => {
    mkdirSync(join(dir, "lock", "heavy.lock"), { recursive: true });
    writeFileSync(join(dir, "lock", "heavy.lock", "pid"), "999999\n");
    const r = await queue().enqueue(job({ cmd: "echo x" }));
    expect(r.outcome).toBe("pass");
  });

  test("F1: a lock whose pid is alive holds a heavy job back until the lock is gone, and a light job is not held", async () => {
    mkdirSync(join(dir, "lock", "heavy.lock"), { recursive: true });
    writeFileSync(join(dir, "lock", "heavy.lock", "pid"), `${process.ppid}\n`);
    const q = queue();
    const heavy = q.enqueue(job({ cmd: "echo heavy" }));
    const light = await q.enqueue(job({ cmd: "echo light", heavy: false }));
    expect(light.outcome).toBe("pass");
    expect(q.pending().map((p) => p.state)).toEqual(["queued"]);
    rmSync(join(dir, "lock", "heavy.lock"), { recursive: true });
    expect((await heavy).outcome).toBe("pass");
  });

  test("F2: light jobs run at the same time", async () => {
    const q = queue();
    await Promise.all([q.enqueue(job({ heavy: false, cmd: traced("A") })), q.enqueue(job({ heavy: false, cmd: traced("B") }))]);
    expect(lines().slice(0, 2).sort()).toEqual(["start A", "start B"]);
  });

  test("F2: a light job runs next to a heavy one", async () => {
    const q = queue();
    await Promise.all([q.enqueue(job({ heavy: true, cmd: traced("H") })), q.enqueue(job({ heavy: false, cmd: traced("L") }))]);
    expect(lines().slice(0, 2).sort()).toEqual(["start H", "start L"]);
  });

  test("F2: two commands listed as a conflict never run together, even when light", async () => {
    const q = queue({ conflicts: [["lint", "format"]] });
    const mk = (name: string, label: string) => q.enqueue(job({ heavy: false, name, cmd: traced(label, "0.15") }));
    await Promise.all([mk("lint", "L"), mk("format", "F"), mk("types", "T")]);
    const l = lines();
    const at = (s: string) => l.indexOf(s);
    // L and F do not overlap, in either order; T is free and starts with L.
    expect(at("end L") < at("start F") || at("end F") < at("start L")).toBe(true);
    expect(at("start T")).toBeLessThan(at("end L"));
    expect(at("start L")).toBeLessThan(at("start F"));
  });

  test("F2: a conflict pair works in both orders", async () => {
    const q = queue({ conflicts: [["lint", "format"]] });
    await Promise.all([
      q.enqueue(job({ heavy: false, name: "format", cmd: traced("F", "0.15") })),
      q.enqueue(job({ heavy: false, name: "lint", cmd: traced("L", "0.15") })),
    ]);
    expect(lines()).toEqual(["start F", "end F", "start L", "end L"]);
  });

  test("D9: a check that runs longer than the timeout is killed and ends as timeout", async () => {
    const q = queue({ timeoutMs: 300 });
    const t0 = Date.now();
    const r = await q.enqueue(job({ cmd: "echo begin; sleep 30" }));
    expect(r.outcome).toBe("timeout");
    expect(r.exit).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.durationMs).toBeGreaterThanOrEqual(250);
  });

  test("D9: the whole process group dies, grandchildren included, and the next job runs", async () => {
    const q = queue({ timeoutMs: 300 });
    const pidFile = join(dir, "child.pid");
    const first = q.enqueue(job({ cmd: `sleep 30 & echo $! > '${pidFile}'; wait` }));
    const second = q.enqueue(job({ cmd: "echo next" }));
    expect((await first).outcome).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await sleep(100);
    expect(alive(pid)).toBe(false);
    expect((await second).outcome).toBe("pass");
  });

  test("D9: a job that ends inside the timeout is not a timeout", async () => {
    const r = await queue({ timeoutMs: 2000 }).enqueue(job({ cmd: "sleep 0.1" }));
    expect(r.outcome).toBe("pass");
  });

  test("F3: drop removes that chat's queued jobs and kills its running job; each ends as dropped", async () => {
    const q = queue();
    const pidFile = join(dir, "run.pid");
    const results: Record<string, CheckResult> = {};
    const mk = (label: string, chat: string, cmd: string) => {
      const j = job({ chat, cmd });
      return q.enqueue(j).then((r) => (results[label] = r));
    };
    const p = [
      mk("run", "chat-a", `echo $$ > '${pidFile}'; sleep 30`),
      mk("q1", "chat-a", "echo q1"),
      mk("other", "chat-b", "echo other"),
      mk("q2", "chat-a", "echo q2"),
    ];
    await sleep(150);
    expect(q.drop("chat-a")).toBe(3);
    await Promise.all(p);
    expect(results.run).toMatchObject({ outcome: "dropped" });
    expect(results.q1).toMatchObject({ outcome: "dropped", exit: null, durationMs: 0 });
    expect(results.q2?.outcome).toBe("dropped");
    expect(results.other?.outcome).toBe("pass");
    await sleep(100);
    expect(alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
    expect(q.pending()).toEqual([]);
  });

  test("F3: drop for a chat with no jobs returns 0", () => {
    expect(queue().drop("nobody")).toBe(0);
  });

  test("F3: dropping a running heavy job frees the heavy slot for the next chat", async () => {
    const q = queue();
    const a = q.enqueue(job({ chat: "chat-a", cmd: "sleep 30" }));
    const b = q.enqueue(job({ chat: "chat-b", cmd: "echo b" }));
    await sleep(100);
    q.drop("chat-a");
    expect((await a).outcome).toBe("dropped");
    expect((await b).outcome).toBe("pass");
    expect(existsSync(join(dir, "lock", "heavy.lock"))).toBe(false);
  });

  test("tailLines gives the last n lines, and nothing for a missing file", () => {
    const f = join(dir, "x.log");
    writeFileSync(f, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const t = tailLines(f).split("\n");
    expect(t).toHaveLength(200);
    expect(t[0]).toBe("line 101");
    expect(t[199]).toBe("line 300");
    expect(tailLines(f, 2)).toBe("line 299\nline 300");
    writeFileSync(f, "a\nb");
    expect(tailLines(f)).toBe("a\nb");
    expect(tailLines(join(dir, "missing.log"))).toBe("");
  });
});
