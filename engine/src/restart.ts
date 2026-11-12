/**
 * What the engine does once, at start. (PLAN.md, edge rows A7, D16, D19, F4)
 *
 * Agents run in tmux, so they outlive the engine. The engine rebuilds its view of them, finishes what the last
 * run left half done, queues the checks again, and then lets the conversations go on. Nothing is pasted to a
 * running agent here: a prompt that was sent is on the `sent` list of run/state.json and never goes out twice.
 *
 * The order matters. The conversations come last, so a message that goes out finds the loop already recovered.
 */

export interface RecoverDeps {
  chats: () => { id: string; featureDir: string | null; halted: boolean }[];
  /** Reads the tmux sessions again. Running agents keep running. */
  rebuildSessions: () => Promise<void>;
  /** The conversations: a queued message goes out (A7). */
  recoverChat: () => Promise<void>;
  loop: {
    /** Finishes a pending commit once, and re-sends a prompt that was recorded and never sent (D19). */
    kick(chatId: string): void;
    /** Queues the check of every `checking` task again. Returns the task ids (D16, F4). */
    recheck(chatId: string): string[];
    buildStatus(chatId: string): { status: string };
  };
  /** Called for each chat with a feature folder that is not halted, after its loop is recovered: an answer that waited goes out. */
  resumed?: (chatId: string) => void;
}

export async function recoverEngine(deps: RecoverDeps): Promise<{ chats: number; rechecked: string[] }> {
  await deps.rebuildSessions();

  const chats = deps.chats();
  const rechecked: string[] = [];
  for (const chat of chats) {
    if (chat.featureDir === null || chat.halted) continue;
    try {
      if (deps.loop.buildStatus(chat.id).status === "running") {
        deps.loop.kick(chat.id);
        for (const task of deps.loop.recheck(chat.id)) rechecked.push(`${chat.id}/${task}`);
      }
      deps.resumed?.(chat.id);
    } catch (e) {
      // One chat with a state file that does not parse must not stop the others.
      console.error(`chat ${chat.id}: not recovered: ${(e as Error).message}`);
    }
  }

  await deps.recoverChat();
  return { chats: chats.length, rechecked };
}
