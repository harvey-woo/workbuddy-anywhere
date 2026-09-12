/**
 * Error types shared by every layer.
 *
 * The HTTP layer has to turn an internal failure into a status code, and it
 * used to do that by regex-matching the error MESSAGE. That works for
 * accidents but not for intent: `Unknown account: x` is the caller's mistake
 * (400), yet it fell through to the "something upstream broke" default (502),
 * which tells an API consumer to retry a request that can never succeed.
 *
 * Anything the caller can fix by sending a different request should throw
 * `BadRequestError`. Everything else is presumed to be an upstream/transport
 * problem.
 */

/** The caller sent something we cannot act on. Maps to HTTP 400. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** The caller must (re-)authenticate. Maps to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}
