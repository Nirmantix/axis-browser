/**
 * Snapshot ref (uid) staleness validation.
 *
 * Lives apart from cli.ts because both entry points need it: the CLI action
 * handlers and the `run` script runtime's `page` helper. cli.ts already imports
 * from run.ts, so run.ts cannot import back without a cycle.
 *
 * A ref's `g<n>:` tag names the snapshot it was minted by. The current
 * generation is read from the page itself, so each tab tracks its own snapshot
 * independently — a session-wide counter would invalidate tab A's refs the
 * moment tab B was snapshotted.
 *
 * A page that reports no state (never snapshotted, or navigated since — which
 * wipes the global) rejects tagged refs outright: they were minted against a
 * different document. The session counter is consulted only when the probe
 * itself fails, where rejecting would punish a transport hiccup rather than a
 * genuinely stale ref.
 */

import { CdpError, callTool } from "./client.js";
import { getCurrentGeneration } from "./generation.js";
import {
  checkUidGeneration,
  parseEvalOutput,
  parseStampedUid,
} from "./snapshot.js";

export type ToolCaller = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<string>;

/** Global the page carries to report which snapshot generation it is on. */
export const PAGE_GENERATION_KEY = "__chromeDevtoolsAxiSnapshotGeneration";

export function throwStaleRef(
  arg: string,
  refGeneration: number | null,
  currentGeneration: number,
): never {
  const refRaw = arg.startsWith("@") ? arg.slice(1) : arg;
  throw new CdpError(
    `Stale ref @${refRaw}: from snapshot generation ${refGeneration}, current is ${currentGeneration}. Re-snapshot to get fresh refs.`,
    "STALE_REF",
    [
      "Run `axis-browser snapshot` to capture current refs, then retry the action",
    ],
  );
}

/**
 * What the page reports about the snapshot it is on.
 *
 * `absent` and `unknown` must stay distinct. A page that answers the probe but
 * carries no state was never snapshotted by this session — most often because
 * it navigated, which wipes the global. Any tagged ref there belongs to a
 * different document and is stale. A probe that *fails* proves nothing, so it
 * stays permissive and defers to the session counter rather than rejecting
 * every ref over a transport hiccup.
 */
export type PageGeneration =
  | { kind: "generation"; value: number }
  | { kind: "absent" }
  | { kind: "unknown" };

/** Read the generation the current page was last snapshotted at. */
export async function getPageRefGeneration(
  caller: ToolCaller,
): Promise<PageGeneration> {
  const key = JSON.stringify(PAGE_GENERATION_KEY);
  try {
    const output = await caller("evaluate_script", {
      function: `() => {
  const state = globalThis[${key}];
  if (!state || typeof state.generation !== 'number') return null;
  return state.generation;
}`,
    });
    const parsed = parseEvalOutput(output);
    if (parsed === null) return { kind: "absent" };
    return typeof parsed === "number" && Number.isFinite(parsed)
      ? { kind: "generation", value: parsed }
      : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

function throwUnsnapshottedPage(arg: string, refGeneration: number): never {
  const refRaw = arg.startsWith("@") ? arg.slice(1) : arg;
  throw new CdpError(
    `Stale ref @${refRaw}: from snapshot generation ${refGeneration}, but the current page has no snapshot from this session — it navigated, or was never snapshotted. Re-snapshot to get fresh refs.`,
    "STALE_REF",
    [
      "Run `axis-browser snapshot` to capture current refs, then retry the action",
    ],
  );
}

/**
 * Strip the `@` prefix and generation tag from a uid ref, throwing STALE_REF
 * when the tag names a snapshot the page has moved past. Untagged refs are
 * accepted for legacy compatibility and skip the page probe entirely.
 */
export async function parseUidFresh(
  arg: string,
  caller: ToolCaller = callTool,
): Promise<string> {
  const { uid, generation } = parseStampedUid(arg);
  if (generation === null) return uid;

  const probe = await getPageRefGeneration(caller);
  if (probe.kind === "absent") {
    throwUnsnapshottedPage(arg, generation);
  }
  const current =
    probe.kind === "generation" ? probe.value : getCurrentGeneration();
  const check = checkUidGeneration(arg, current);
  if (check.stale) {
    throwStaleRef(arg, check.refGeneration, current);
  }
  return check.uid;
}
