export interface RefInfo {
  ref: string;
  label: string;
  type: string;
}

/** Count interactive refs (uid=...) in snapshot text. */
export function countRefs(snapshot: string): number {
  const matches = snapshot.match(/\buid=\S+/g);
  return matches ? matches.length : 0;
}

/** Extract ref IDs with labels and types from snapshot text. */
export function extractRefs(snapshot: string): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/\buid=(\S+)\s+(\w+)\s+"([^"]*)"/);
    if (!m) continue;
    refs.push({ ref: m[1], type: m[2], label: m[3] });
  }
  return refs;
}

export interface ParsedUid {
  /** The raw upstream uid (without @ prefix and without generation tag). */
  uid: string;
  /** The snapshot generation the ref was minted in, or null if untagged (legacy). */
  generation: number | null;
}

/**
 * Parse a uid argument that may carry an `@` prefix and/or a generation tag.
 * Examples: `@g7:237_15` -> { uid: "237_15", generation: 7 }
 *           `@237_15`    -> { uid: "237_15", generation: null }
 *           `g3:abc`     -> { uid: "abc", generation: 3 }
 */
export function parseStampedUid(arg: string): ParsedUid {
  const stripped = arg.startsWith("@") ? arg.slice(1) : arg;
  const m = stripped.match(/^g(\d+):(.+)$/);
  if (m) return { uid: m[2], generation: Number.parseInt(m[1], 10) };
  return { uid: stripped, generation: null };
}

/**
 * Rewrite every `uid=<id>` token in snapshot text to carry a generation tag,
 * e.g. `uid=237_15` -> `uid=g7:237_15`. Already-stamped tokens are left alone
 * so this is idempotent. Agents feed tagged refs back to action commands, so a
 * ref minted by an earlier snapshot fails loudly instead of silently no-op'ing
 * against a superseded tree. The tag identifies the snapshot a ref came from,
 * not the DOM's revision: unrelated mutations do not invalidate it, because
 * resolving a uid that no longer exists is already an error downstream.
 */
export function stampSnapshotGeneration(
  snapshot: string,
  generation: number,
): string {
  return snapshot.replace(/\buid=(\S+)/g, (match, uid: string) => {
    if (/^g\d+:/.test(uid)) return match;
    return `uid=g${generation}:${uid}`;
  });
}

export interface UidCheckResult {
  /** The raw upstream uid (no @ prefix, no generation tag). */
  uid: string;
  /** True when the ref carries a generation tag that does not match current. */
  stale: boolean;
  /** The generation embedded in the ref, or null if the ref was untagged. */
  refGeneration: number | null;
}

/**
 * Pure validation: given a ref argument and the current snapshot generation,
 * return the upstream uid plus whether the ref is stale. Untagged refs are
 * accepted (legacy compatibility) and reported as not-stale.
 */
export function checkUidGeneration(
  arg: string,
  currentGeneration: number,
): UidCheckResult {
  const { uid, generation } = parseStampedUid(arg);
  return {
    uid,
    stale: generation !== null && generation !== currentGeneration,
    refGeneration: generation,
  };
}

/** Extract page title from snapshot (RootWebArea or first heading). */
export function extractTitle(snapshot: string): string {
  const rootMatch = snapshot.match(/RootWebArea\s+"([^"]+)"/);
  if (rootMatch) return rootMatch[1];
  const headingMatch = snapshot.match(/\bheading\s+"([^"]+)"/);
  if (headingMatch) return headingMatch[1];
  return "";
}

/**
 * Strip everything before the actual accessibility tree (MCP may prepend
 * status lines and headers).
 */
export function stripSnapshotHeader(text: string): string {
  const lines = text.split("\n");
  const treeStart = lines.findIndex((l) => /\bRootWebArea\b|\buid=/.test(l));
  if (treeStart > 0) return lines.slice(treeStart).join("\n");
  return text.replace(/^[\s\S]*?##\s+Latest page snapshot\s*\n/, "");
}

/** Extract the actual JS value from an MCP evaluate_script response wrapper. */
export function parseEvalOutput(output: string): unknown {
  const jsonBlock = output.match(/```json\n([\s\S]*?)\n```/);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1].trim());
    } catch {
      return jsonBlock[1].trim();
    }
  }
  const preamble = "Script ran on page and returned:";
  if (output.includes(preamble)) {
    const raw = output.slice(output.indexOf(preamble) + preamble.length).trim();
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return output.trim();
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  totalLength: number;
}

export function truncateSnapshot(
  snapshot: string,
  full: boolean,
  limit = 16000,
): TruncationResult {
  const totalLength = snapshot.length;
  if (full || totalLength <= limit) {
    return { text: snapshot, truncated: false, totalLength };
  }
  const cut = snapshot.lastIndexOf("\n", limit);
  const text = cut > 0 ? snapshot.slice(0, cut) : snapshot.slice(0, limit);
  return { text, truncated: true, totalLength };
}

/**
 * Truncate arbitrary text keeping both head and tail so recent/trailing data is preserved.
 * Used for eval output where the end of the result is often as important as the beginning.
 */
const MARKER_OVERHEAD = 50;

export function truncateText(text: string, limit = 8000): TruncationResult {
  const totalLength = text.length;
  if (totalLength <= limit) {
    return { text, truncated: false, totalLength };
  }
  // The omission marker adds overhead; skip truncation when
  // the text is short enough that truncating would produce a longer result.
  if (totalLength <= limit + MARKER_OVERHEAD) {
    return { text, truncated: false, totalLength };
  }
  const headBudget = Math.floor(limit * 0.4);
  const tailBudget = limit - headBudget;
  // Cut at line boundaries when possible
  const headCut = text.lastIndexOf("\n", headBudget);
  const head = headCut > 0 ? text.slice(0, headCut) : text.slice(0, headBudget);
  const tailStart = text.indexOf("\n", totalLength - tailBudget);
  const tail =
    tailStart > 0 && tailStart < totalLength
      ? text.slice(tailStart + 1)
      : text.slice(totalLength - tailBudget);
  const omitted = totalLength - head.length - tail.length;
  const result = `${head}\n\n... (${omitted} chars omitted, ${totalLength} total) ...\n\n${tail}`;
  return { text: result, truncated: true, totalLength };
}

const INPUT_TYPES = ["textbox", "searchbox", "input", "combobox", "textarea"];

/** Check if a ref type is an input/form field. */
export function isInputType(type: string): boolean {
  return INPUT_TYPES.includes(type);
}
