import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeProcess,
  autoReapOrphans,
  claimedBridgePids,
  findOrphanBridges,
  listBridgeProcesses,
  parseElapsed,
  reapBridges,
  scanSessionPidFiles,
} from "../src/reap.js";

const HOUR = 3_600_000;

describe("parseElapsed", () => {
  it("MM:SS", () => expect(parseElapsed("05:30")).toBe(330_000));
  it("HH:MM:SS", () => expect(parseElapsed("01:00:00")).toBe(HOUR));
  it("DD-HH:MM:SS", () => expect(parseElapsed("2-00:00:00")).toBe(48 * HOUR));
  it("garbage does not become NaN", () => expect(parseElapsed("??")).toBe(0));
});

describe("listBridgeProcesses", () => {
  const ps = [
    "  101     1   101    04:00:00 node /opt/axis/bin/chrome-devtools-axi-bridge.js",
    "  202     1   202       05:00 npx tsx /opt/axis/bin/chrome-devtools-axi-bridge.ts",
    "  303     1   303    01:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless",
    "  404     1   404       00:01 grep chrome-devtools-axi-bridge",
    "  505     1   505    02:00:00 node /opt/other-tool/server.js",
  ].join("\n");

  it("finds only our bridges", () => {
    const found = listBridgeProcesses(() => ps);
    expect(found.map((p) => p.pid)).toEqual([101, 202]);
  });

  it("never matches a browser", () => {
    expect(listBridgeProcesses(() => ps).some((p) => p.pid === 303)).toBe(
      false,
    );
  });

  it("does not match a grep looking for itself", () => {
    expect(listBridgeProcesses(() => ps).some((p) => p.pid === 404)).toBe(
      false,
    );
  });

  it("returns nothing rather than guessing when ps is unavailable", () => {
    expect(
      listBridgeProcesses(() => {
        throw new Error("ps: not found");
      }),
    ).toEqual([]);
  });

  it("parses age", () => {
    expect(listBridgeProcesses(() => ps)[0].ageMs).toBe(4 * HOUR);
  });
});

describe("claimedBridgePids / findOrphanBridges", () => {
  let home: string;

  const bridge = (pid: number, ageMs: number, ppid = 1): BridgeProcess => ({
    pid,
    ppid,
    pgid: pid,
    ageMs,
    command: "node chrome-devtools-axi-bridge.js",
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-reap-"));
    mkdirSync(join(home, ".axis-browser", "sessions", "worker-1"), {
      recursive: true,
    });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads the default session's PID file", () => {
    writeFileSync(
      join(home, ".axis-browser", "bridge.pid"),
      JSON.stringify({ pid: 101, port: 9224 }),
    );
    expect(claimedBridgePids(home).has(101)).toBe(true);
  });

  it("reads named sessions' PID files too", () => {
    writeFileSync(
      join(home, ".axis-browser", "sessions", "worker-1", "bridge.pid"),
      JSON.stringify({ pid: 202, port: 9301 }),
    );
    expect(claimedBridgePids(home).has(202)).toBe(true);
  });

  it("a malformed PID file claims nothing", () => {
    writeFileSync(join(home, ".axis-browser", "bridge.pid"), "{not json");
    expect(claimedBridgePids(home).size).toBe(0);
  });

  it("but an unparseable PID file is reported, not silently treated as absent", () => {
    // The distinction the two consumers need: manual reap still acts, automatic
    // reaping must not destroy a process on the strength of a file it could not read.
    const file = join(home, ".axis-browser", "bridge.pid");
    writeFileSync(file, "{not json");
    const scan = scanSessionPidFiles(home);
    expect(scan.claimed.size).toBe(0);
    expect(scan.malformed).toEqual([file]);
  });

  it("well-formed JSON without a numeric pid also counts as malformed", () => {
    const file = join(home, ".axis-browser", "bridge.pid");
    writeFileSync(file, JSON.stringify({ port: 9224 }));
    expect(scanSessionPidFiles(home).malformed).toEqual([file]);
  });

  it("a truncated PID file does not stop MANUAL reap from finding orphans", () => {
    writeFileSync(join(home, ".axis-browser", "bridge.pid"), "");
    const orphans = findOrphanBridges(4 * HOUR, home, [bridge(999, 9 * HOUR)]);
    expect(orphans.map((o) => o.pid)).toEqual([999]);
  });

  it("a claimed bridge is never an orphan, however old", () => {
    writeFileSync(
      join(home, ".axis-browser", "bridge.pid"),
      JSON.stringify({ pid: 101, port: 9224 }),
    );
    const orphans = findOrphanBridges(4 * HOUR, home, [
      bridge(101, 100 * HOUR),
    ]);
    expect(orphans).toEqual([]);
  });

  it("a young unclaimed bridge is not an orphan — it may still be starting up", () => {
    // A bridge that has not yet written its PID file looks exactly like an orphan
    // to a concurrent command. The age floor is what makes reaping safe on a hot path.
    expect(findOrphanBridges(4 * HOUR, home, [bridge(999, 30_000)])).toEqual(
      [],
    );
  });

  it("an old unclaimed bridge is an orphan", () => {
    const orphans = findOrphanBridges(4 * HOUR, home, [bridge(999, 5 * HOUR)]);
    expect(orphans.map((o) => o.pid)).toEqual([999]);
  });

  it("claims the whole bridge tree, not just the pid in the PID file", () => {
    // Regression: a live bridge is `npm exec tsx` -> tsx CLI -> bridge, and only the
    // innermost writes the PID file. Found by running reap --min-age-hours 0 --dry-run
    // against a live session and watching it name that session's own npx and tsx pids.
    // Reaping those kills the healthy bridge with them (the kill targets the group).
    writeFileSync(
      join(home, ".axis-browser", "bridge.pid"),
      JSON.stringify({ pid: 88645, port: 9232 }),
    );
    const tree = [
      bridge(88618, 9 * HOUR, 1), // npm exec tsx
      bridge(88639, 9 * HOUR, 88618), // tsx cli
      bridge(88645, 9 * HOUR, 88639), // the bridge itself — the claimed pid
    ];
    expect(findOrphanBridges(4 * HOUR, home, tree)).toEqual([]);
  });

  it("still reports a genuinely unrelated old bridge alongside a claimed tree", () => {
    writeFileSync(
      join(home, ".axis-browser", "bridge.pid"),
      JSON.stringify({ pid: 88645, port: 9232 }),
    );
    const orphans = findOrphanBridges(4 * HOUR, home, [
      bridge(88618, 9 * HOUR, 1),
      bridge(88645, 9 * HOUR, 88618),
      bridge(777, 9 * HOUR, 1), // nobody's
    ]);
    expect(orphans.map((o) => o.pid)).toEqual([777]);
  });

  it("never reports the current process", () => {
    const orphans = findOrphanBridges(0, home, [
      bridge(process.pid, 99 * HOUR),
    ]);
    expect(orphans).toEqual([]);
  });
});

describe("reapBridges", () => {
  it("kills nothing in dry-run mode and reports what it would have killed", () => {
    const outcome = reapBridges(
      [
        {
          pid: 999_999,
          ppid: 1,
          pgid: 999_999,
          ageMs: 5 * HOUR,
          command: "x",
        },
      ],
      { dryRun: true },
    );
    expect(outcome).toEqual({ reaped: [], failed: [], skipped: [999_999] });
  });
});

describe("autoReapOrphans", () => {
  it("is disabled by CHROME_DEVTOOLS_AXI_AUTO_REAP=0", () => {
    expect(autoReapOrphans({ CHROME_DEVTOOLS_AXI_AUTO_REAP: "0" })).toBe(0);
  });

  it("never throws — cleanup must not break a command", () => {
    expect(() => autoReapOrphans({})).not.toThrow();
  });
});
