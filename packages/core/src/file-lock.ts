/**
 * Cross-process advisory lock for a single file.
 *
 * `FileAuthStore` and `FileSettingsStore` both do read-modify-write on a whole
 * JSON document, and more than one process is expected to point at the same
 * directory (the dsh plugin and `wbaw serve` both default to
 * `~/.workbuddy-anywhere`). Atomic writes (`temp file + rename`) guarantee the
 * file is never *corrupt*, but they do nothing to stop two writers from
 * interleaving: each reads the document, changes one account, and writes the
 * whole thing back — so whichever finishes second silently discards the other's
 * change. Serialising the read AND the write is what closes that window, which
 * is why callers must hold the lock across both.
 *
 * The lock is a sibling file created with `O_CREAT | O_EXCL`, which is atomic on
 * every filesystem we care about. It is *advisory* and NOT re-entrant: take it
 * once, around one read-modify-write.
 *
 * ## Releasing someone else's lock is the dangerous part
 *
 * A holder that dies without releasing (SIGKILL, power loss) would otherwise
 * wedge every other process, so a lock that looks abandoned gets removed. Doing
 * that carelessly is worse than not doing it at all, because deleting a lock
 * that is actually alive lets TWO processes hold it at once — the exact lost
 * update this file exists to prevent. Two rules keep that from happening, and
 * the first one is not obvious:
 *
 *   1. A lock that has *vanished* is never treated as stale. Releasing is a
 *      plain unlink, so waiters constantly observe "gone" at the very moment the
 *      holder finishes. Reading that as "infinitely old" and deleting races
 *      directly into the fresh lock the next waiter just created: we would
 *      delete a live lock and then create our own, so both of us proceed. A
 *      missing lock means "try to create it", nothing more.
 *   2. Staleness must be observed TWICE, a poll interval apart. That is what
 *      separates a dead holder's lock from one that was released and re-created
 *      between our two syscalls — `unlink` cannot be made conditional on the
 *      file's contents, so a second look is the only evidence available.
 *
 * Real holds last about a millisecond, so {@link STALE_MS} is far above anything
 * legitimate and these removals only ever happen after a genuine crash.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Age at which a lock is presumed abandoned and may be removed. */
const STALE_MS = 10_000;
/** How long to wait for a contended lock before giving up on locking at all. */
const TIMEOUT_MS = 15_000;
/** Poll interval while waiting. */
const RETRY_MS = 15;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Modification time of `file`, or `undefined` when it does not exist. */
async function mtimeOf(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Whether `lockPath` looks abandoned.
 *
 * `false` when the file is missing: see rule (1) above — an absent lock is one
 * we may create, never one we may delete.
 */
async function looksAbandoned(lockPath: string): Promise<boolean> {
  const held = await mtimeOf(lockPath);
  if (held === undefined) return false;
  return Date.now() - held > STALE_MS;
}

/**
 * Run `fn` while holding an exclusive cross-process lock on `target`.
 *
 * Never throws on contention. If the lock cannot be taken within
 * {@link TIMEOUT_MS} — reachable only when another process is genuinely stuck
 * holding it — `fn` runs anyway, with a warning on stderr. Hanging a login
 * behind a stray lock file is worse than the lost update that trades against,
 * and the caller sees the problem instead of waiting on it.
 */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = `${target}.lock`;
  await fs.mkdir(path.dirname(target), { recursive: true });

  const started = Date.now();
  let handle: fs.FileHandle | undefined;

  while (handle === undefined) {
    try {
      // `wx` = O_CREAT | O_EXCL: creates it, or fails because we do not own it.
      handle = await fs.open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      if (await looksAbandoned(lockPath)) {
        await sleep(RETRY_MS);
        // Second look, a poll apart: a lock that was released and re-created in
        // between now looks young, and we leave it alone.
        if (await looksAbandoned(lockPath)) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      }

      if (Date.now() - started > TIMEOUT_MS) {
        console.error(
          `[wbaw] ${path.basename(lockPath)} has been held for over ` +
            `${Math.round(TIMEOUT_MS / 1000)}s — proceeding without it. ` +
            `Another process may be stuck; a concurrent write could be lost.`
        );
        return await fn();
      }
      await sleep(RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    // Safe unconditionally: `O_EXCL` created this file for us, and no waiter can
    // have removed and re-created it while we held it — a waiter only deletes a
    // lock it has just observed as ABANDONED, and ours has existed for
    // milliseconds at most.
    await fs.unlink(lockPath).catch(() => undefined);
  }
}
