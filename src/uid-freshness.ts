/**
 * Snapshot ref (uid) freshness — the one UID freshness module.
 *
 * Merged from upstream `chrome-devtools-axi` 0.1.35's `src/uid-freshness.ts`
 * and this fork's former `src/refs.ts` (now deleted): one implementation, one
 * set of semantics, no duplicated marker or stamping code.
 *
 * Capture side (upstream). `captureFreshSnapshot` bumps the session generation,
 * installs a `MutationObserver` marker on the page, captures the tree, and
 * re-captures once when the page was still mutating during the first capture —
 * so the stamped snapshot describes a settled tree rather than a half-rendered
 * one.
 *
 * Validation side (fork). A ref's `g<n>:` tag names the snapshot that minted
 * it, and the page reports the generation it was last snapshotted at, so each
 * tab tracks its own refs independently — a session-wide counter would
 * invalidate tab A's refs the moment tab B was snapshotted.
 *
 * Deliberate divergence from upstream 0.1.35: a nonzero `mutations` count does
 * **not** invalidate a ref. Upstream re-added mutation counting to ref
 * validation, which is the behavior this fork removed because any mutation
 * anywhere in the document — a spinner tick, a re-render — invalidated every
 * ref in the snapshot between `snapshot` and `click`. The observer still earns
 * its keep on the capture side, where it decides whether to re-capture. Ref
 * staleness here is decided by the generation tag alone:
 *
 * - untagged (legacy) refs are accepted and skip the page probe entirely;
 * - a page that answers the probe but carries no state was never snapshotted by
 *   this session (most often it navigated, which wipes the global), so a tagged
 *   ref there belongs to a different document and is stale;
 * - a probe that *fails* proves nothing, so it stays permissive and defers to
 *   the session counter rather than rejecting every ref over a transport
 *   hiccup.
 */

import { CdpError, callTool } from "./client.js";
import { bumpGeneration, getCurrentGeneration } from "./generation.js";
import {
  checkUidGeneration,
  parseEvalOutput,
  parseStampedUid,
  stampSnapshotGeneration,
} from "./snapshot.js";

export type ToolCaller = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<string>;

/** Global the page carries to report which snapshot generation it is on. */
export const PAGE_GENERATION_KEY = "__chromeDevtoolsAxiSnapshotGeneration";

/** What the page's freshness marker reported, as written by this CLI. */
interface PageRefState {
  generation: number;
  mutations: number;
}

/**
 * Result of asking the page which snapshot it is on.
 *
 * `absent` and `unknown` must stay distinct: a page that answers with no state
 * was never snapshotted by this session, while a probe that failed proves
 * nothing at all.
 */
export type PageRefProbe =
  | { kind: "state"; state: PageRefState }
  | { kind: "absent" }
  | { kind: "unknown" };

interface CapturedSnapshot {
  generation: number;
  snapshot: string;
  state: PageRefState | null;
}

/**
 * Capture a snapshot, tag it with a freshly bumped generation, and install the
 * page marker that later `parseUidFresh` calls validate against. Re-captures
 * once when the page was still mutating during the first capture.
 */
export async function captureFreshSnapshot(
  caller: ToolCaller,
  capture: () => Promise<string>,
): Promise<string> {
  const first = await captureSnapshot(caller, capture);
  const fresh =
    first.state?.generation === first.generation && first.state.mutations > 0
      ? await captureSnapshot(caller, capture)
      : first;
  return stampSnapshotGeneration(fresh.snapshot, fresh.generation);
}

async function captureSnapshot(
  caller: ToolCaller,
  capture: () => Promise<string>,
): Promise<CapturedSnapshot> {
  const generation = bumpGeneration();
  await markPageSnapshotGeneration(generation, caller);
  const snapshot = await capture();
  const probe = await getPageRefProbe(caller);
  return {
    generation,
    snapshot,
    state: probe.kind === "state" ? probe.state : null,
  };
}

/**
 * Best-effort: on failure the caller falls back to the session-wide file
 * counter, which costs per-page precision but never blocks the command.
 */
async function markPageSnapshotGeneration(
  generation: number,
  caller: ToolCaller,
): Promise<void> {
  const key = JSON.stringify(PAGE_GENERATION_KEY);
  try {
    await caller("evaluate_script", {
      function: `() => {
  const key = ${key};
  const previous = globalThis[key];
  if (previous && previous.observer) previous.observer.disconnect();
  const state = { generation: ${generation}, mutations: 0, observer: null };
  const observer = new MutationObserver(() => { state.mutations += 1; });
  observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
  state.observer = observer;
  globalThis[key] = state;
  return state.generation;
}`,
    });
  } catch {}
}

/**
 * Read the freshness marker the current page carries.
 *
 * Accepts both marker shapes this CLI has written: the current
 * `{ generation, mutations }` object and the older bare generation number, so a
 * page marked by an earlier build in the same session still validates.
 */
export async function getPageRefProbe(
  caller: ToolCaller,
): Promise<PageRefProbe> {
  const key = JSON.stringify(PAGE_GENERATION_KEY);
  // The whole probe is fail-soft, parse included: a probe that errors, or that
  // answers with something this CLI cannot read, proves nothing about the page.
  // Reporting `unknown` lets the caller fall back to the session counter rather
  // than turning a transport hiccup into a rejected ref or a thrown TypeError.
  try {
    const output = await caller("evaluate_script", {
      function: `() => {
  const state = globalThis[${key}];
  if (!state || typeof state.generation !== 'number') return null;
  const mutations = typeof state.mutations === 'number' ? state.mutations : 0;
  return { generation: state.generation, mutations };
}`,
    });
    if (typeof output !== "string") return { kind: "unknown" };
    const parsed = parseEvalOutput(output);
    if (parsed === null) return { kind: "absent" };
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      return { kind: "state", state: { generation: parsed, mutations: 0 } };
    }
    if (typeof parsed === "object") {
      const candidate = parsed as Partial<PageRefState>;
      if (
        typeof candidate.generation === "number" &&
        Number.isFinite(candidate.generation)
      ) {
        const mutations =
          typeof candidate.mutations === "number" &&
          Number.isFinite(candidate.mutations)
            ? candidate.mutations
            : 0;
        return {
          kind: "state",
          state: { generation: candidate.generation, mutations },
        };
      }
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

function throwStaleRef(
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

  const probe = await getPageRefProbe(caller);
  if (probe.kind === "absent") {
    throwUnsnapshottedPage(arg, generation);
  }
  const current =
    probe.kind === "state" ? probe.state.generation : getCurrentGeneration();
  const check = checkUidGeneration(arg, current);
  if (check.stale) {
    throwStaleRef(arg, check.refGeneration, current);
  }
  return check.uid;
}
