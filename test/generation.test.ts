import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bumpGeneration, getCurrentGeneration } from "../src/generation.js";

/**
 * This counter underpins stale-ref detection: a misread sends parseUidFresh a
 * wrong "current" generation, so refs are validated against the wrong snapshot.
 *
 * The counter lives on disk under homedir(), which follows $HOME, so each test
 * runs against a throwaway home and its own session name.
 */
const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
const savedHome = process.env.HOME;
let home: string;
let counterFile: string;

const SESSION = "gen-test";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "axis-generation-"));
  process.env.HOME = home;
  process.env.CHROME_DEVTOOLS_AXI_SESSION = SESSION;
  counterFile = join(
    home,
    ".axis-browser",
    "sessions",
    SESSION,
    "snapshot-generation",
  );
});

afterEach(() => {
  if (savedSession === undefined)
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
  else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
  // If HOME was unset to begin with, restoring "nothing" means deleting it —
  // otherwise the temp dir removed below stays as HOME for every later test.
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("generation counter", () => {
  it("reads 0 before any snapshot has been taken", () => {
    expect(getCurrentGeneration()).toBe(0);
  });

  it("bump returns the new value and getCurrent reads it back", () => {
    expect(bumpGeneration()).toBe(1);
    expect(getCurrentGeneration()).toBe(1);
    expect(bumpGeneration()).toBe(2);
    expect(getCurrentGeneration()).toBe(2);
  });

  it("persists the counter to disk, since each CLI invocation is a new process", () => {
    bumpGeneration();
    bumpGeneration();
    bumpGeneration();
    // A fresh read is what the next short-lived CLI process does.
    expect(getCurrentGeneration()).toBe(3);
  });

  it("keeps sessions independent", () => {
    bumpGeneration();
    bumpGeneration();

    process.env.CHROME_DEVTOOLS_AXI_SESSION = "gen-test-other";
    expect(getCurrentGeneration()).toBe(0);
    expect(bumpGeneration()).toBe(1);

    process.env.CHROME_DEVTOOLS_AXI_SESSION = SESSION;
    expect(getCurrentGeneration()).toBe(2);
  });

  it("treats a corrupt counter file as 0 rather than NaN", () => {
    // NaN fails every generation comparison, which would mark every ref stale.
    bumpGeneration();
    writeFileSync(counterFile, "not-a-number");

    expect(getCurrentGeneration()).toBe(0);
    expect(bumpGeneration()).toBe(1);
  });

  it("ignores surrounding whitespace in the counter file", () => {
    bumpGeneration();
    writeFileSync(counterFile, "  41 \n");

    expect(getCurrentGeneration()).toBe(41);
    expect(bumpGeneration()).toBe(42);
  });
});

describe("generation counter session-name validation", () => {
  it("rejects a dot-only session instead of reading the default session's counter", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    expect(() => getCurrentGeneration()).toThrow(/Invalid/);
    expect(() => bumpGeneration()).toThrow(/Invalid/);
  });
});
