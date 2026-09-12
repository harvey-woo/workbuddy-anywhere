/**
 * Ids for the objects each protocol returns.
 *
 * Every protocol uses a different prefix (`msg_`, `toolu_`, `resp_`, `fc_`),
 * and clients are free to treat them as opaque — but they are also the only
 * thing tying a streamed object to the one it belongs to, so they must be
 * unique per object even when two arrive in the same millisecond.
 */

export function randomId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}
