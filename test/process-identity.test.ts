import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_COMMAND_MARKER,
  identityIsBridge,
  identityMatchesRecord,
  readProcessGroupId,
  readProcessIdentity,
  type ProcessIdentity,
  type ProbeRunner,
} from "../src/process-identity.js";

const LSTART = "Sun Sep 27 00:24:35 2026";
// The `ps` layout puts lstart in a fixed-width leading column; a single-digit
// day is space-padded so the field is always exactly 24 chars.
const LSTART_PADDED_DAY = "Mon Oct  5 09:15:02 2026";

describe("readProcessIdentity (POSIX ps output)", () => {
  const deps = { platform: "linux" as NodeJS.Platform };

  it("parses lstart and command from the fixed-width leading column", () => {
    expect(
      readProcessIdentity(42, {
        ...deps,
        runner: () =>
          `${LSTART} node /path/chrome-devtools-axi-bridge --port 9224`,
      }),
    ).toEqual({
      startedAt: LSTART,
      command: "node /path/chrome-devtools-axi-bridge --port 9224",
    });
  });

  it("accepts a space-padded single-digit day", () => {
    expect(
      readProcessIdentity(42, {
        ...deps,
        runner: () => `${LSTART_PADDED_DAY} some-command`,
      }),
    ).toEqual({ startedAt: LSTART_PADDED_DAY, command: "some-command" });
  });

  it("passes the pid to a single ps invocation so the pair is one observation", () => {
    const runner = vi.fn<ProbeRunner>(() => `${LSTART} cmd`);
    readProcessIdentity(4242, { ...deps, runner });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("ps", [
      "-p",
      "4242",
      "-o",
      "lstart=,command=",
    ]);
  });

  it("keeps newlines inside the command line — the timestamp is positional", () => {
    const command = `node -e\nconsole.log("x")`;
    expect(
      readProcessIdentity(42, {
        ...deps,
        runner: () => `${LSTART} ${command}`,
      }),
    ).toEqual({ startedAt: LSTART, command });
  });

  it("returns null when ps fails", () => {
    expect(readProcessIdentity(42, { ...deps, runner: () => null })).toBeNull();
  });

  it("returns null for output too short to hold a timestamp", () => {
    for (const short of ["", "Sun Sep", `${LSTART}`.slice(0, 23) + "x"]) {
      expect(
        readProcessIdentity(42, { ...deps, runner: () => short }),
      ).toBeNull();
    }
  });

  it("returns null when the leading field is not a lstart-shaped timestamp", () => {
    for (const bad of [
      "XXX Sep 27 00:24:35 2026 cmd",
      "Sun ZZZ 27 00:24:35 2026 cmd",
      "Sun Sep 27 00:24:35 202 cmd",
      `${LSTART.slice(0, 23)}t${LSTART.slice(23)} cmd`,
      // N.B. `${LSTART}\\tcmd` legitimately parses: the tab sits in the
      // command field (columns 24+), so it is not a malformed timestamp.
    ]) {
      expect(
        readProcessIdentity(42, { ...deps, runner: () => bad }),
      ).toBeNull();
    }
  });

  it("returns null when the command line is empty", () => {
    expect(
      readProcessIdentity(42, { ...deps, runner: () => `${LSTART}   ` }),
    ).toBeNull();
  });

  it("returns null for a non-positive pid without probing", () => {
    const runner = vi.fn<ProbeRunner>(() => `${LSTART} cmd`);
    for (const pid of [0, -1, NaN, 1.5]) {
      expect(readProcessIdentity(pid, { ...deps, runner })).toBeNull();
    }
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("readProcessIdentity (Windows powershell output)", () => {
  const deps = { platform: "win32" as NodeJS.Platform };

  it("splits command from start time at the first pipe", () => {
    const runner: ProbeRunner = (command, args) => {
      expect(command).toBe("powershell.exe");
      expect(args.join(" ")).toContain("ProcessId=42");
      return "2026-09-27T00:24:35.1234567+00:00|node bridge | still the command";
    };
    expect(readProcessIdentity(42, { ...deps, runner })).toEqual({
      startedAt: "2026-09-27T00:24:35.1234567+00:00",
      command: "node bridge | still the command",
    });
  });

  it("returns null when the probe fails or has no separator", () => {
    expect(readProcessIdentity(42, { ...deps, runner: () => null })).toBeNull();
    expect(
      readProcessIdentity(42, { ...deps, runner: () => "no separator" }),
    ).toBeNull();
  });

  it("returns null for a non-ISO timestamp — null CreationDate must not pass", () => {
    expect(
      readProcessIdentity(42, { ...deps, runner: () => "garbage|node cmd" }),
    ).toBeNull();
  });

  it("returns null for an empty CommandLine — access denied is unverifiable", () => {
    expect(
      readProcessIdentity(42, {
        ...deps,
        runner: () => "2026-09-27T00:24:35+00:00|   ",
      }),
    ).toBeNull();
  });
});

describe("readProcessGroupId", () => {
  it("parses the pgid field", () => {
    const runner: ProbeRunner = (_command, args) => {
      expect(args).toEqual(["-p", "42", "-o", "pgid="]);
      return "  78195\n";
    };
    expect(readProcessGroupId(42, { platform: "linux", runner })).toBe(78195);
  });

  it("returns null on Windows — POSIX process groups do not exist there", () => {
    const runner = vi.fn<ProbeRunner>(() => "1");
    expect(readProcessGroupId(42, { platform: "win32", runner })).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns null for invalid input without probing", () => {
    const runner = vi.fn<ProbeRunner>(() => "1");
    for (const pid of [0, -3, NaN]) {
      expect(readProcessGroupId(pid, { platform: "linux", runner })).toBeNull();
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns null when ps fails or answers garbage or a non-positive pgid", () => {
    for (const output of [null, "not a number", "0", "-2", ""]) {
      expect(
        readProcessGroupId(42, {
          platform: "linux",
          runner: () => output,
        }),
      ).toBeNull();
    }
  });
});

describe("identityIsBridge / identityMatchesRecord", () => {
  const bridge: ProcessIdentity = {
    command: `node /repo/bin/${BRIDGE_COMMAND_MARKER}.js --port 9224`,
    startedAt: LSTART,
  };

  it("recognizes a bridge by its command-line marker", () => {
    expect(identityIsBridge(bridge)).toBe(true);
    expect(identityIsBridge(null)).toBe(false);
    expect(
      identityIsBridge({ command: "vim main.ts", startedAt: LSTART }),
    ).toBe(false);
    expect(
      identityIsBridge({
        command: `${BRIDGE_COMMAND_MARKER}-impostor`,
        startedAt: LSTART,
      }),
    ).toBe(true); // substring match: an impostor containing the marker counts
  });

  it("matches only when the observed identity is the same bridge start", () => {
    expect(identityMatchesRecord(bridge, LSTART)).toBe(true);
    // A recycled PID running a new bridge fails on start time.
    expect(
      identityMatchesRecord(
        { ...bridge, startedAt: "Mon Oct  5 09:15:02 2026" },
        LSTART,
      ),
    ).toBe(false);
    // Same start, different process: not a bridge at all.
    expect(
      identityMatchesRecord({ command: "sleep 60", startedAt: LSTART }, LSTART),
    ).toBe(false);
    expect(identityMatchesRecord(null, LSTART)).toBe(false);
  });
});

// Probing the real `ps`/`powershell` is POSIX-safe here; skip on Windows CI.
describe.skipIf(process.platform === "win32")("real process probes", () => {
  it("reads this process's own identity and group", () => {
    const identity = readProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    expect(identity!.command.length).toBeGreaterThan(0);
    expect(identity!.startedAt).toMatch(
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/,
    );
    expect(readProcessGroupId(process.pid)).toBeGreaterThan(0);
  });

  it("returns null for a pid that does not exist", () => {
    // PID 2^22 is past Linux's default pid_max and macOS's 99998 range;
    // either way `ps` fails and the runner must map that to null.
    expect(readProcessIdentity(4_000_000)).toBeNull();
    expect(readProcessGroupId(4_000_000)).toBeNull();
  });
});

describe("runner contract", () => {
  // A ProbeRunner is typed `=> string | null`, but these probes are the
  // fail-closed gate in front of every signal Axis sends: their promise is "null
  // means do not act". A runner that breaks its own contract — an injected stub,
  // or `execFileSync` without an `encoding`, which yields a Buffer — used to
  // surface as a bare TypeError from `.slice`, replacing a refusal with a crash
  // on the termination path. Every result is now type-checked at the boundary.
  const nonStringRunners: ReadonlyArray<[string, ProbeRunner]> = [
    ["a number", (() => 42) as unknown as ProbeRunner],
    [
      "a Buffer",
      (() =>
        Buffer.from(
          "Sun Sep 27 00:24:35 2026 node x",
        )) as unknown as ProbeRunner,
    ],
    ["undefined", (() => undefined) as unknown as ProbeRunner],
  ];

  for (const [label, runner] of nonStringRunners) {
    it(`returns null rather than throwing when the runner yields ${label}`, () => {
      expect(readProcessIdentity(42, { platform: "linux", runner })).toBeNull();
      expect(readProcessGroupId(42, { platform: "linux", runner })).toBeNull();
    });
  }

  it("returns null when the runner throws", () => {
    const runner: ProbeRunner = () => {
      throw new Error("probe exploded");
    };
    // A throwing runner is still a contract violation, but it must not escape
    // either: the caller's decision is "do not signal", not "crash".
    expect(() =>
      readProcessIdentity(42, { platform: "linux", runner }),
    ).not.toThrow();
    expect(readProcessIdentity(42, { platform: "linux", runner })).toBeNull();
  });
});
