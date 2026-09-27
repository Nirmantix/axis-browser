import { describe, expect, it } from "vitest";
import { decode, encode } from "@toon-format/toon";

/**
 * Golden wire-output tests for the TOON encoder.
 *
 * `src/cli.ts` imports `encode` once and feeds it every machine-readable block
 * the CLI prints — page metadata, errors, status, results, the reap report — so
 * a TOON major bump is a change to this CLI's output format, not a routine
 * dependency refresh. The 2.3.0 → 4.1.1 move removed `keyFolding` /
 * `flattenDepth`, added keyed and nested tabular array forms, and started
 * quoting strings that lead with `#` or `+`. These tests pin the exact bytes a
 * caller sees, so any future bump that moves them fails here rather than
 * silently reformatting an agent's parsed output.
 *
 * Every payload below is a shape cli.ts actually builds; the comments name the
 * call site.
 */

/** Payloads whose encoding is byte-identical under TOON 2.3.0 and 4.1.1. */
const UNCHANGED: ReadonlyArray<{
  name: string;
  payload: unknown;
  expected: string;
}> = [
  {
    // cli.ts formatPageOutput — the page metadata block under open/snapshot.
    name: "page metadata",
    payload: {
      page: { title: "Airlock", url: "https://example.com/x", refs: 42 },
    },
    expected:
      'page:\n  title: Airlock\n  url: "https://example.com/x"\n  refs: 42',
  },
  {
    // cli.ts renderErrorBlocks — error plus stable machine code.
    name: "error and code",
    payload: { error: "Stale ref @g3:12_3", code: "STALE_REF" },
    expected: 'error: "Stale ref @g3:12_3"\ncode: STALE_REF',
  },
  {
    // cli.ts handleStart.
    name: "status with port",
    payload: { status: "ready", port: 8765 },
    expected: "status: ready\nport: 8765",
  },
  {
    // cli.ts handleResize — a nested object of scalars.
    name: "nested scalars",
    payload: { resized: { width: 1280, height: 720 } },
    expected: "resized:\n  width: 1280\n  height: 720",
  },
  {
    // cli.ts handleReap — arrays of uniform flat objects were already tabular
    // under 2.3.0, so the report an operator reads did not move.
    name: "reap report",
    payload: {
      orphans: [
        { pid: 111, ageMinutes: 260 },
        { pid: 222, ageMinutes: 300 },
      ],
      reaped: [111],
      failed: [],
      dryRun: true,
      wouldReap: [222],
    },
    expected:
      "orphans[2]{pid,ageMinutes}:\n  111,260\n  222,300\nreaped[1]: 111\nfailed: []\ndryRun: true\nwouldReap[1]: 222",
  },
];

/**
 * Payloads whose encoding deliberately changed in TOON 4. Each is a strict
 * widening of quoting or an added tabular form: the decoded value is identical,
 * which the round-trip test below asserts for both groups.
 */
const CHANGED: ReadonlyArray<{
  name: string;
  payload: unknown;
  expected: string;
  note: string;
}> = [
  {
    name: "hash-leading string",
    payload: { ref: "#g7:12_3", color: "#ff0000" },
    expected: 'ref: "#g7:12_3"\ncolor: "#ff0000"',
    note: "2.3.0 emitted `color: #ff0000` bare, where `#` reads as a comment; 4.x quotes it.",
  },
  {
    name: "plus-leading string",
    payload: { phone: "+15551234567", diff: "+added" },
    expected: 'phone: "+15551234567"\ndiff: +added',
    note: "4.x quotes a `+` that would otherwise read as a numeric sign; interior `+` is untouched.",
  },
  {
    name: "tabular rows with a nested object",
    payload: {
      requests: [
        {
          id: 1,
          url: "https://example.com/a",
          status: 200,
          headers: { Authorization: "Bearer x" },
        },
      ],
    },
    expected:
      'requests[1]{id,url,status,headers{Authorization}}:\n  1,"https://example.com/a",200,Bearer x',
    note: "2.3.0 fell back to the indented `- key: value` list form whenever a row held a nested object; 4.x keeps the tabular form and names the nested keys in the header.",
  },
];

describe("TOON encoder golden output", () => {
  it.each(UNCHANGED)("pins $name exactly", ({ payload, expected }) => {
    expect(encode(payload)).toBe(expected);
  });

  it.each(CHANGED)("pins the changed $name form", ({ payload, expected }) => {
    expect(encode(payload)).toBe(expected);
  });

  it("keeps ref syntax intact through the encoder", () => {
    // Refs are the one token agents copy back into the next command, so their
    // representation is part of the CLI contract: a stamped ref round-trips
    // verbatim, with or without the `@` a caller types.
    for (const ref of ["g7:12_3", "@g7:12_3", "12_3", "@12_3"]) {
      const encoded = encode({ uid: ref });
      expect(encoded).toContain(ref.replace(/^@/, ""));
      expect(decode(encoded)).toEqual({ uid: ref });
    }
  });

  it("round-trips every golden payload to an equal value", () => {
    // A caller that decodes what this CLI prints must get the same data back —
    // the format moved, the values did not.
    for (const { name, payload } of [...UNCHANGED, ...CHANGED]) {
      const encoded = encode(payload);
      expect(decode(encoded), name).toEqual(payload);
    }
  });

  it("reads TOON 2.3.0 output with the current decoder", () => {
    // Encodings produced before the bump are still in the wild (saved reports,
    // transcripts, an agent's cached output). The bare-`#` form is the one 2.3.0
    // shape 4.x re-quotes on encode, so pin that it still decodes to the same
    // value rather than to a comment-stripped fragment.
    expect(decode("color: #ff0000")).toEqual({ color: "#ff0000" });
    expect(decode("requests[1]:\n  - id: 1\n    status: 200")).toEqual({
      requests: [{ id: 1, status: 200 }],
    });
  });

  it("exposes no key-folding options", () => {
    // TOON 4 removed keyFolding/flattenDepth. If a future bump brings back an
    // option that collapses single-key chains into dotted paths, this CLI's
    // nested blocks (`page:`, `resized:`) would change shape; fail here so the
    // move is a decision rather than a surprise.
    const encoded = encode({ page: { refs: 1 } });
    expect(encoded).not.toContain("page.refs");
    expect(encoded).toBe("page:\n  refs: 1");
  });
});
