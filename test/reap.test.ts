import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // reapBridges settles with `sleep 1` between signal batches; the pause is
    // production behaviour, not something these tests need to wait through.
    // Everything else (ps, powershell) passes through untouched.
    execFileSync: ((command: unknown, args: unknown, ...rest: unknown[]) =>
      command === "sleep"
        ? ""
        : (actual.execFileSync as (...a: unknown[]) => unknown)(
            command,
            args,
            ...rest,
          )) as unknown,
  };
});

const HOUR = 3_600_000;

/** A bridge command line, matching the marker both modules check for. */
const BRIDGE_COMMAND = "node /opt/axis/bin/chrome-devtools-axi-bridge.js";
/** Two distinct process start times, as `ps lstart` renders them. */
const STARTED_T1 = "Sat Sep 26 08:00:00 2026";
const STARTED_T2 = "Sat Sep 26 09:30:00 2026";

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

  // Identity probes are injected so these tests never depend on a real `ps`.
  const noIdentity = () => null;

  it("finds only our bridges", () => {
    const found = listBridgeProcesses(() => ps, noIdentity);
    expect(found.map((p) => p.pid)).toEqual([101, 202]);
  });

  it("never matches a browser", () => {
    expect(
      listBridgeProcesses(() => ps, noIdentity).some((p) => p.pid === 303),
    ).toBe(false);
  });

  it("does not match a grep looking for itself", () => {
    expect(
      listBridgeProcesses(() => ps, noIdentity).some((p) => p.pid === 404),
    ).toBe(false);
  });

  it("returns nothing rather than guessing when ps is unavailable", () => {
    expect(
      listBridgeProcesses(() => {
        throw new Error("ps: not found");
      }, noIdentity),
    ).toEqual([]);
  });

  it("parses age", () => {
    expect(listBridgeProcesses(() => ps, noIdentity)[0].ageMs).toBe(4 * HOUR);
  });

  it("records each bridge's start time as the baseline for later re-reads", () => {
    const found = listBridgeProcesses(
      () => ps,
      (pid) => ({ command: BRIDGE_COMMAND, startedAt: `T${pid}` }),
    );
    expect(found[0].startedAt).toBe("T101");
    expect(found[1].startedAt).toBe("T202");
  });

  it("records a null start time when the identity probe fails", () => {
    const found = listBridgeProcesses(() => ps, noIdentity);
    expect(found[0].startedAt).toBeNull();
  });
});

describe("claimedBridgePids / findOrphanBridges", () => {
  let home: string;

  const bridge = (pid: number, ageMs: number, ppid = 1): BridgeProcess => ({
    pid,
    ppid,
    pgid: pid,
    ageMs,
    command: BRIDGE_COMMAND,
    startedAt: STARTED_T1,
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
  /** Pids the simulated OS reports as live. */
  let alive: Set<number>;
  /** Pids that survive SIGTERM and only die on SIGKILL. */
  let stubborn: Set<number>;
  /** Pids that reject every signal with EPERM and stay alive. */
  let denied: Set<number>;
  /** Every real signal delivered, in order: negative pid = group signal. */
  let kills: [number, string][];

  beforeEach(() => {
    alive = new Set();
    stubborn = new Set();
    denied = new Set();
    kills = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const bare = Math.abs(pid);
      if (signal === 0) {
        if (alive.has(bare)) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (!alive.has(bare)) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      kills.push([pid, String(signal)]);
      if (denied.has(bare)) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      if (signal === "SIGKILL" || !stubborn.has(bare)) alive.delete(bare);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const target = (
    pid: number,
    startedAt: string | null = STARTED_T1,
    pgid: number = pid,
  ): BridgeProcess => ({
    pid,
    ppid: 1,
    pgid,
    ageMs: 9 * HOUR,
    command: BRIDGE_COMMAND,
    startedAt,
  });

  const bridgeIdentity = (startedAt: string) => ({
    command: BRIDGE_COMMAND,
    startedAt,
  });

  /** Identity reader that keeps reporting the listing's bridge identity while alive. */
  const sameBridge = (pid: number) =>
    alive.has(pid) ? bridgeIdentity(STARTED_T1) : null;

  it("kills nothing in dry-run mode and reports what it would have killed", () => {
    const outcome = reapBridges([target(999_999)], { dryRun: true });
    expect(outcome).toEqual({ reaped: [], failed: [], skipped: [999_999] });
    expect(kills).toEqual([]);
  });

  it("group-signals a verified target that leads its own process group", () => {
    alive.add(9100);
    const outcome = reapBridges([target(9100)], { readIdentity: sameBridge });
    expect(kills).toEqual([[-9100, "SIGTERM"]]);
    expect(outcome).toEqual({ reaped: [9100], failed: [], skipped: [] });
  });

  it("bare-signals a verified target that is not its group leader", () => {
    alive.add(9200);
    const outcome = reapBridges([target(9200, STARTED_T1, 500)], {
      readIdentity: sameBridge,
    });
    expect(kills).toEqual([[9200, "SIGTERM"]]);
    expect(outcome).toEqual({ reaped: [9200], failed: [], skipped: [] });
  });

  it("never signals a pid recycled between the listing and the signal", () => {
    // The listing saw a bridge at 9300 started at T1; by signal time the pid
    // belongs to a different process started at T2.
    alive.add(9300);
    const outcome = reapBridges([target(9300, STARTED_T1)], {
      readIdentity: () => bridgeIdentity(STARTED_T2),
    });
    expect(kills).toEqual([]);
    expect(outcome).toEqual({ reaped: [], failed: [], skipped: [9300] });
  });

  it("never signals a pid whose identity can no longer be read", () => {
    // Still alive, but the probe fails — e.g. it vanished mid-check or the OS
    // refused. Unverifiable means untouchable.
    alive.add(9400);
    const outcome = reapBridges([target(9400)], {
      readIdentity: () => null,
    });
    expect(kills).toEqual([]);
    expect(outcome).toEqual({ reaped: [], failed: [], skipped: [9400] });
  });

  it("never signals a target whose start time was never recorded", () => {
    // The listing could not establish a baseline, so there is nothing to
    // compare a re-read against — even a perfect bridge identity does not help.
    alive.add(9500);
    const outcome = reapBridges([target(9500, null)], {
      readIdentity: () => bridgeIdentity(STARTED_T1),
    });
    expect(kills).toEqual([]);
    expect(outcome).toEqual({ reaped: [], failed: [], skipped: [9500] });
  });

  it("never signals a pid whose command no longer names a bridge", () => {
    // Same start time, so it is plausibly the same process — but it is not our
    // bridge any more, so it is not ours to signal.
    alive.add(9600);
    const outcome = reapBridges([target(9600)], {
      readIdentity: () => ({
        command: "node /opt/other-tool/server.js",
        startedAt: STARTED_T1,
      }),
    });
    expect(kills).toEqual([]);
    expect(outcome).toEqual({ reaped: [], failed: [], skipped: [9600] });
  });

  it("re-verifies identity before the SIGKILL escalation", () => {
    // Survives SIGTERM, gets re-checked, still matches, gets SIGKILL.
    alive.add(9700);
    stubborn.add(9700);
    const outcome = reapBridges([target(9700)], { readIdentity: sameBridge });
    expect(kills).toEqual([
      [-9700, "SIGTERM"],
      [-9700, "SIGKILL"],
    ]);
    expect(outcome).toEqual({ reaped: [9700], failed: [], skipped: [] });
  });

  it("does not escalate a pid that fails re-verification after SIGTERM", () => {
    // SIGTERM went out while 9800 was still our bridge; the process survived,
    // and the re-read before SIGKILL finds a different start time — the pid was
    // recycled during the settle. The escalation must not follow it.
    alive.add(9800);
    stubborn.add(9800);
    let reads = 0;
    const outcome = reapBridges([target(9800)], {
      readIdentity: () =>
        ++reads === 1 ? bridgeIdentity(STARTED_T1) : bridgeIdentity(STARTED_T2),
    });
    expect(kills).toEqual([[-9800, "SIGTERM"]]);
    // Signalled but no longer verifiably ours: skipped, never failed.
    expect(outcome).toEqual({ reaped: [], failed: [], skipped: [9800] });
  });

  it("signals verified targets while skipping unverifiable ones", () => {
    alive.add(9900);
    alive.add(9901);
    const outcome = reapBridges([target(9900), target(9901)], {
      readIdentity: (pid) =>
        pid === 9900 ? sameBridge(pid) : bridgeIdentity(STARTED_T2),
    });
    expect(kills).toEqual([[-9900, "SIGTERM"]]);
    expect(outcome).toEqual({
      reaped: [9900],
      failed: [],
      skipped: [9901],
    });
  });

  it("reports a verified target that survives every signal as failed", () => {
    // Identity checks all pass; the OS simply refuses to let us kill it. This
    // is the only honest reading of "signalled and still alive".
    alive.add(9950);
    denied.add(9950);
    const outcome = reapBridges([target(9950)], { readIdentity: sameBridge });
    expect(kills).toEqual([
      [-9950, "SIGTERM"],
      [-9950, "SIGKILL"],
    ]);
    expect(outcome).toEqual({ reaped: [], failed: [9950], skipped: [] });
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
