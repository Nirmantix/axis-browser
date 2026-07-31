/**
 * Error classification shared by the CLI handlers and the `run` script runtime.
 *
 * Deliberately separate from client.ts: tests replace that module wholesale
 * (`vi.mock("../src/client.js")`) with their own CdpError class, so a predicate
 * living there would instanceof-check against the real class while callers
 * throw the mock's. Importing CdpError from here resolves to whichever class
 * the caller's module graph has, which is what these checks want.
 */

import { CdpError } from "./client.js";

/**
 * True when an `open` failure is recoverable by falling back to new_page —
 * the target went away rather than the browser being broken.
 */
export function isRecoverableOpenError(error: unknown): error is CdpError {
  if (!(error instanceof CdpError)) return false;
  if (error.code !== "BROWSER_ERROR") return false;
  return /not connected|session (?:closed|not found)|no page/i.test(
    error.message,
  );
}
