import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_BASE_PORT,
  DEFAULT_SESSION_NAME,
  clearBridgeRecord,
  clearLegacyBridgeRecord,
  defaultPortForSession,
  readBridgeRecord,
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
  resolveSessionStateDir,
  validateSessionName,
  writeBridgeRecord,
} from "../src/sessions.js";

const STATE_DIR = join(homedir(), ".axis-browser");

describe("resolveSessionName", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.CHROME_DEVTOOLS_AXI_SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
  });

  afterEach(() => {
    if (saved.CHROME_DEVTOOLS_AXI_SESSION === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION =
        saved.CHROME_DEVTOOLS_AXI_SESSION;
    }
  });

  it('defaults to "default" when unset', () => {
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it('defaults to "default" when empty or whitespace', () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "   ";
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it("trims the configured name", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "  worker-1  ";
    expect(resolveSessionName()).toBe("worker-1");
  });

  it("throws on a configured-but-unsafe name", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "../escape";
    expect(() => resolveSessionName()).toThrow(/Invalid/);
  });

  it("throws on a dot-only name that would collapse onto the default dir", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    expect(() => resolveSessionName()).toThrow(/Invalid/);
  });
});

describe("validateSessionName", () => {
  it('accepts "default" and safe names', () => {
    expect(() => validateSessionName(DEFAULT_SESSION_NAME)).not.toThrow();
    expect(() => validateSessionName("worker-1")).not.toThrow();
    expect(() => validateSessionName("ceo.admin_2")).not.toThrow();
  });

  it("rejects path traversal and separators", () => {
    expect(() => validateSessionName("../escape")).toThrow(/Invalid/);
    expect(() => validateSessionName("a/b")).toThrow(/Invalid/);
  });

  it("rejects dot-only names that would collapse onto the default dir", () => {
    expect(() => validateSessionName(".")).toThrow(/Invalid/);
    expect(() => validateSessionName("..")).toThrow(/Invalid/);
    expect(() => validateSessionName("...")).toThrow(/Invalid/);
  });

  it("rejects shell metacharacters and spaces", () => {
    expect(() => validateSessionName("a b")).toThrow(/Invalid/);
    expect(() => validateSessionName("a;b")).toThrow(/Invalid/);
    expect(() => validateSessionName("a$b")).toThrow(/Invalid/);
  });

  it("rejects empty and overlong names", () => {
    expect(() => validateSessionName("")).toThrow(/Invalid/);
    expect(() => validateSessionName("x".repeat(65))).toThrow(/Invalid/);
  });
});

describe("defaultPortForSession", () => {
  it("returns the base port for the default session", () => {
    expect(defaultPortForSession(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("is deterministic per name", () => {
    expect(defaultPortForSession("worker-1")).toBe(
      defaultPortForSession("worker-1"),
    );
  });

  it("stays within the named-session range (9225..10224)", () => {
    for (const name of ["a", "worker-1", "ceo", "x".repeat(64)]) {
      const port = defaultPortForSession(name);
      expect(port).toBeGreaterThanOrEqual(DEFAULT_BASE_PORT + 1);
      expect(port).toBeLessThanOrEqual(DEFAULT_BASE_PORT + 1000);
    }
  });

  it("spreads distinct names across ports", () => {
    const ports = new Set(["alice", "bob", "carol"].map(defaultPortForSession));
    expect(ports.size).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveSessionPort", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.CHROME_DEVTOOLS_AXI_PORT = process.env.CHROME_DEVTOOLS_AXI_PORT;
    delete process.env.CHROME_DEVTOOLS_AXI_PORT;
  });

  afterEach(() => {
    if (saved.CHROME_DEVTOOLS_AXI_PORT === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_PORT;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_PORT = saved.CHROME_DEVTOOLS_AXI_PORT;
    }
  });

  it("uses the session-derived port when no explicit override", () => {
    expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("honors an explicit CHROME_DEVTOOLS_AXI_PORT", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = "9999";
    expect(resolveSessionPort("worker-1")).toBe(9999);
  });

  it("rejects ports outside the TCP range and echoes the raw value", () => {
    for (const raw of ["0", "-1", "65536", "100000"]) {
      process.env.CHROME_DEVTOOLS_AXI_PORT = raw;
      expect(() => resolveSessionPort()).toThrow(
        `Invalid CHROME_DEVTOOLS_AXI_PORT "${raw}"`,
      );
      expect(() => resolveSessionPort()).toThrow(/1-65535/);
    }
  });

  it("rejects values that are not canonical decimal port strings", () => {
    // Only /^\d{1,5}$/ survives the guard — hex, floats, signed, and decimal
    // digits with stray text all fail loudly instead of silently degrading.
    for (const raw of ["abc", "80.5", "0x10", "+80", "80x", "１２３"]) {
      process.env.CHROME_DEVTOOLS_AXI_PORT = raw;
      expect(() => resolveSessionPort()).toThrow(
        `Invalid CHROME_DEVTOOLS_AXI_PORT "${raw}"`,
      );
    }
  });

  it("trims surrounding whitespace but still range-checks the result", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = " 8080 ";
    expect(resolveSessionPort()).toBe(8080);
    process.env.CHROME_DEVTOOLS_AXI_PORT = " -1 ";
    // The message echoes the *trimmed* value the operator typed.
    expect(() => resolveSessionPort()).toThrow(
      'Invalid CHROME_DEVTOOLS_AXI_PORT "-1"',
    );
  });

  it("falls back to the session port when the override is empty or whitespace", () => {
    for (const raw of ["", "   "]) {
      process.env.CHROME_DEVTOOLS_AXI_PORT = raw;
      expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
    }
  });

  it("names the session's own fallback port in the error", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = "nope";
    expect(() => resolveSessionPort("worker-9")).toThrow(
      new RegExp(
        `this session's own port \\(${defaultPortForSession("worker-9")}\\)`,
      ),
    );
  });
});

describe("session state paths", () => {
  it("keeps legacy paths for the default session", () => {
    expect(resolveSessionStateDir(DEFAULT_SESSION_NAME)).toBe(STATE_DIR);
    expect(resolveSessionPidFile(DEFAULT_SESSION_NAME)).toBe(
      join(STATE_DIR, "bridge.pid"),
    );
  });

  it("nests named sessions under sessions/<name>/", () => {
    expect(resolveSessionStateDir("worker-1")).toBe(
      join(STATE_DIR, "sessions", "worker-1"),
    );
    expect(resolveSessionPidFile("worker-1")).toBe(
      join(STATE_DIR, "sessions", "worker-1", "bridge.pid"),
    );
  });
});

describe("session paths reject an unsafe CHROME_DEVTOOLS_AXI_SESSION", () => {
  const saved = process.env.CHROME_DEVTOOLS_AXI_SESSION;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = saved;
    }
  });

  it("throws from the env-default path resolvers instead of collapsing to the default dir", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    expect(() => resolveSessionStateDir()).toThrow(/Invalid/);
    expect(() => resolveSessionPidFile()).toThrow(/Invalid/);
    expect(() => resolveSessionPort()).toThrow(/Invalid/);
  });
});

describe("bridge record (pid/port + capability token)", () => {
  const savedHome = process.env.HOME;
  let home: string;
  let pidFile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-sessions-record-"));
    process.env.HOME = home;
    pidFile = resolveSessionPidFile("record-worker");
    mkdirSync(dirname(pidFile), { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    // The 0600 fixture can resist recursive removal on some platforms.
    try {
      chmodSync(pidFile, 0o600);
    } catch {
      // Already gone.
    }
    rmSync(home, { recursive: true, force: true });
  });

  const authed = {
    pid: 4321,
    port: 9333,
    token: "tok-abc",
    startedAt: "Fri Sep 26 12:00:00 2026",
  };

  it("round-trips an authenticated record verbatim", () => {
    writeBridgeRecord(authed, pidFile);
    expect(readBridgeRecord(pidFile)).toEqual(authed);
  });

  it("writes the record owner-read/write-only, never world-readable", () => {
    // The token in this file is an ambient-capability secret — mode 0600 is
    // part of the auth boundary, not cosmetic.
    writeBridgeRecord(authed, pidFile);
    expect(lstatSync(pidFile).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(pidFile, "utf8")) as Record<
      string,
      unknown
    >;
    // No unexpected fields beyond what readers rely on.
    expect(Object.keys(persisted).sort()).toEqual([
      "pid",
      "port",
      "startedAt",
      "token",
    ]);
  });

  it("returns a bare pid/port record for tokenless legacy files", () => {
    // Pre-auth records are *readable* — they just are not adoptable for RPC;
    // stop needs the pid to retire them.
    writeFileSync(pidFile, JSON.stringify({ pid: 7, port: 8 }));
    expect(readBridgeRecord(pidFile)).toEqual({ pid: 7, port: 8 });
  });

  it("drops empty token/startedAt fields while keeping pid and port", () => {
    writeFileSync(
      pidFile,
      JSON.stringify({ pid: 7, port: 8, token: "", startedAt: "" }),
    );
    expect(readBridgeRecord(pidFile)).toEqual({ pid: 7, port: 8 });
  });

  it("returns null for records that fail the pid/port shape check", () => {
    const malformed = [
      { pid: "nope", port: 1, token: "t", startedAt: "t" },
      { pid: 1, port: "nope", token: "t", startedAt: "t" },
      { pid: 1.5, port: 2, token: "t", startedAt: "t" },
      null,
      "a string",
      42,
    ];
    for (const record of malformed) {
      writeFileSync(pidFile, JSON.stringify(record));
      expect(readBridgeRecord(pidFile)).toBeNull();
    }
  });

  it("returns null for invalid JSON rather than throwing", () => {
    writeFileSync(pidFile, "{not json");
    expect(readBridgeRecord(pidFile)).toBeNull();
  });

  // chmod-based unreadability only denies the reader on POSIX and when not
  // running as root: root reads through 0o000, and Windows does not map the
  // mode bits onto the owner's ACL. Everywhere else the test would assert a
  // denial that never happened.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns null when the file is unreadable",
    () => {
      writeBridgeRecord(authed, pidFile);
      chmodSync(pidFile, 0o000);
      try {
        expect(readBridgeRecord(pidFile)).toBeNull();
      } finally {
        chmodSync(pidFile, 0o600);
      }
    },
  );

  it("returns null when reading a different session's record path", () => {
    writeBridgeRecord(authed, pidFile);
    expect(readBridgeRecord(resolveSessionPidFile("other-worker"))).toBeNull();
  });

  it("clears a record only when pid and token both still match", () => {
    writeBridgeRecord(authed, pidFile);

    // A newer bridge's record (different token): left alone.
    clearBridgeRecord({ pid: authed.pid, token: "other-token" }, pidFile);
    expect(existsSync(pidFile)).toBe(true);

    // A recycled-pid record (different pid, same token): left alone.
    clearBridgeRecord({ pid: authed.pid + 1, token: authed.token }, pidFile);
    expect(existsSync(pidFile)).toBe(true);

    clearBridgeRecord({ pid: authed.pid, token: authed.token }, pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("never clears a tokenless record through the token-guarded path", () => {
    writeFileSync(pidFile, JSON.stringify({ pid: 7, port: 8 }));
    clearBridgeRecord({ pid: 7, token: "irrelevant" }, pidFile);
    expect(existsSync(pidFile)).toBe(true);
  });

  it("clears a tokenless legacy record only through the pid-guarded path", () => {
    writeFileSync(pidFile, JSON.stringify({ pid: 7, port: 8 }));

    // A different live pid: the record may belong to a restarted bridge.
    clearLegacyBridgeRecord({ pid: 8 }, pidFile);
    expect(existsSync(pidFile)).toBe(true);

    clearLegacyBridgeRecord({ pid: 7 }, pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("never clears an authenticated record through the legacy path", () => {
    writeBridgeRecord(authed, pidFile);
    clearLegacyBridgeRecord({ pid: authed.pid }, pidFile);
    expect(existsSync(pidFile)).toBe(true);
  });
});
