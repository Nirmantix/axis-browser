import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { getCommandHelp, parseFillFormArgs } from "../src/cli.js";
import { parseUidFresh } from "../src/refs.js";
import * as generation from "../src/generation.js";

/** A page that reports it is on snapshot generation `n`. */
function pageAtGeneration(n: number) {
  return vi
    .fn()
    .mockResolvedValue(
      `Script ran on page and returned:\n\`\`\`json\n${n}\n\`\`\``,
    );
}

describe("getCommandHelp", () => {
  it("returns non-null for hover", () => {
    expect(getCommandHelp("hover")).not.toBeNull();
  });

  it("returns non-null for drag", () => {
    expect(getCommandHelp("drag")).not.toBeNull();
  });

  it("returns non-null for fillform", () => {
    expect(getCommandHelp("fillform")).not.toBeNull();
  });

  it("returns non-null for dialog", () => {
    expect(getCommandHelp("dialog")).not.toBeNull();
  });

  it("returns non-null for upload", () => {
    expect(getCommandHelp("upload")).not.toBeNull();
  });

  it("hover help includes --full", () => {
    const help = getCommandHelp("hover")!;
    expect(help).toContain("--full");
  });

  it("dialog help does NOT include --full", () => {
    const help = getCommandHelp("dialog")!;
    expect(help).not.toContain("--full");
  });
});

describe("parseFillFormArgs", () => {
  it("parses a single @uid=value entry", () => {
    const result = parseFillFormArgs(['@1="hello"']);
    expect(result.entries).toEqual([{ uid: "1", value: "hello" }]);
  });

  it("strips @ prefix from uid", () => {
    const result = parseFillFormArgs(['@abc="test"']);
    expect(result.entries[0].uid).toBe("abc");
  });

  it("handles multiple entries", () => {
    const result = parseFillFormArgs(['@1="hello"', '@2="world"']);
    expect(result.entries).toEqual([
      { uid: "1", value: "hello" },
      { uid: "2", value: "world" },
    ]);
  });

  it("returns empty array for no valid entries", () => {
    const result = parseFillFormArgs(["invalid", "nope"]);
    expect(result.entries).toEqual([]);
  });

  it("handles values without quotes", () => {
    const result = parseFillFormArgs(["@1=hello"]);
    expect(result.entries).toEqual([{ uid: "1", value: "hello" }]);
  });

  it("handles empty args array", () => {
    const result = parseFillFormArgs([]);
    expect(result.entries).toEqual([]);
  });
});

describe("parseUidFresh (generation validation)", () => {
  beforeEach(() => {
    vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the bare uid for a fresh generation-tagged ref", async () => {
    await expect(
      parseUidFresh("@g7:237_15", pageAtGeneration(7)),
    ).resolves.toBe("237_15");
  });

  it("returns the bare uid for an untagged legacy ref", async () => {
    await expect(parseUidFresh("@237_15", pageAtGeneration(7))).resolves.toBe(
      "237_15",
    );
  });

  it("throws STALE_REF on an older-generation ref", async () => {
    let caught: unknown;
    try {
      await parseUidFresh("@g3:237_15", pageAtGeneration(7));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { code?: string };
    expect(e.code).toBe("STALE_REF");
    expect(e.message).toContain("generation 3");
    expect(e.message).toContain("current is 7");
    expect(e.message).toContain("@g3:237_15");
  });

  it("throws STALE_REF on a newer-generation ref (defensive)", async () => {
    await expect(
      parseUidFresh("@g9:237_15", pageAtGeneration(7)),
    ).rejects.toThrow(/Stale ref/);
  });

  it("works without an @ prefix on the input", async () => {
    await expect(parseUidFresh("g7:abc", pageAtGeneration(7))).resolves.toBe(
      "abc",
    );
    await expect(parseUidFresh("g4:abc", pageAtGeneration(7))).rejects.toThrow(
      /Stale ref/,
    );
  });

  it("throws STALE_REF when the page reports a newer snapshot generation", async () => {
    await expect(
      parseUidFresh("@g7:237_15", pageAtGeneration(8)),
    ).rejects.toMatchObject({ code: "STALE_REF" });
  });

  it("keeps refs valid across DOM mutations within one snapshot", async () => {
    // The page reports the generation stamped at snapshot time and nothing
    // else; DOM churn must not advance it, or every ref in the snapshot would
    // be invalidated by an unrelated spinner tick or re-render.
    const page = pageAtGeneration(7);

    await expect(parseUidFresh("@g7:237_15", page)).resolves.toBe("237_15");
    await expect(parseUidFresh("@g7:99_1", page)).resolves.toBe("99_1");
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("skips the page probe entirely for an untagged ref", async () => {
    const page = pageAtGeneration(7);

    await expect(parseUidFresh("@237_15", page)).resolves.toBe("237_15");
    expect(page).not.toHaveBeenCalled();
  });

  it("rejects a tagged ref when the page carries no snapshot state", async () => {
    // A page that answers the probe with null was never snapshotted by this
    // session — usually because it navigated, which wipes the global. The ref
    // belongs to a different document, so accepting it would act on a stale
    // tree even though the tag matches the session counter.
    const navigatedPage = vi
      .fn()
      .mockResolvedValue(
        "Script ran on page and returned:\n```json\nnull\n```",
      );

    await expect(
      parseUidFresh("@g7:237_15", navigatedPage),
    ).rejects.toMatchObject({ code: "STALE_REF" });
    await expect(parseUidFresh("@g7:237_15", navigatedPage)).rejects.toThrow(
      /no snapshot from this session/,
    );
  });

  it("stays permissive when the probe itself fails", async () => {
    // A failed probe proves nothing about the page; rejecting every ref over a
    // transport hiccup would be worse than deferring to the session counter.
    const brokenProbe = vi.fn().mockRejectedValue(new Error("bridge down"));

    await expect(parseUidFresh("@g7:237_15", brokenProbe)).resolves.toBe(
      "237_15",
    );
  });
});
