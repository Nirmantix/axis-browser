import { describe, expect, it, vi } from "vitest";
import type { Stats } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertStateDirOwned,
  assertWindowsAclPrivate,
  currentUserSid,
  hardenStateDirs,
  PRIVATE_DIR_MODE,
  readWindowsAceSids,
  repairWindowsAcl,
  repairWindowsFileAcl,
  StateDirError,
} from "../src/state-dir.js";
import type { ProbeRunner } from "../src/process-identity.js";

const UID = 501;
const USER_SID = "S-1-5-21-1000";
const SYSTEM_SID = "S-1-5-18";
const EVERYONE_SID = "S-1-1-0";

interface FakeEntry {
  kind: "dir" | "file" | "symlink";
  mode: number;
  uid: number;
}

function entryStats(entry: FakeEntry): Stats {
  return {
    isDirectory: () => entry.kind === "dir",
    isSymbolicLink: () => entry.kind === "symlink",
    isFile: () => entry.kind === "file",
    mode: entry.mode,
    uid: entry.uid,
  } as Stats;
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: no such file or directory"), {
    code: "ENOENT",
  });
}

/**
 * A fully in-memory fs so hardenStateDirs can be exercised through its deps
 * seam with no real directories. `createdMode` models a mkdir whose result is
 * more permissive than requested (a restrictive umask cannot be the culprit —
 * umask only strips bits from 700, it cannot leak group/other access).
 */
function fakeFs(
  seed: Record<string, FakeEntry> = {},
  options: { createdMode?: number } = {},
) {
  const entries = new Map(Object.entries(seed));
  const mkdirCalls: string[] = [];
  const chmodCalls: Array<{ path: string; mode: number }> = [];
  return {
    entries,
    mkdirCalls,
    chmodCalls,
    deps: {
      platform: "linux" as NodeJS.Platform,
      getuid: () => UID,
      lstat: (path: string): Stats => {
        const entry = entries.get(path);
        if (!entry) throw enoent();
        return entryStats(entry);
      },
      mkdir: (path: string, mode: number) => {
        if (entries.has(path))
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        mkdirCalls.push(path);
        entries.set(path, {
          kind: "dir",
          mode: options.createdMode ?? mode,
          uid: UID,
        });
      },
      chmod: (path: string, mode: number) => {
        const entry = entries.get(path);
        if (!entry) throw enoent();
        chmodCalls.push({ path, mode });
        entry.mode = mode;
      },
    },
  };
}

const ownedDir = (mode = 0o700): FakeEntry => ({ kind: "dir", mode, uid: UID });

describe("hardenStateDirs (POSIX)", () => {
  const chain = ["/home/u/.axis-browser", "/home/u/.axis-browser/sessions"];

  it("creates a missing chain base-first with mode 700", () => {
    const fs = fakeFs();
    hardenStateDirs(chain, fs.deps);
    expect(fs.mkdirCalls).toEqual(chain);
    for (const dir of chain) {
      expect(fs.entries.get(dir)?.mode).toBe(PRIVATE_DIR_MODE);
    }
    expect(fs.chmodCalls).toEqual([]);
  });

  it("re-checks after mkdir: a directory created too open is chmod'ed to 700", () => {
    // mkdir's result must be verified, not assumed — a fs that ignores the
    // requested mode would otherwise leave the token dir group-readable.
    const fs = fakeFs({}, { createdMode: 0o755 });
    hardenStateDirs(chain, fs.deps);
    expect(fs.chmodCalls).toEqual(
      chain.map((path) => ({ path, mode: PRIVATE_DIR_MODE })),
    );
    for (const dir of chain) {
      expect(fs.entries.get(dir)?.mode).toBe(PRIVATE_DIR_MODE);
    }
  });

  it("tightens a pre-existing 0755 tree (the common upgrade case)", () => {
    const fs = fakeFs({
      [chain[0]]: ownedDir(0o755),
      [chain[1]]: ownedDir(0o755),
    });
    hardenStateDirs(chain, fs.deps);
    expect(fs.mkdirCalls).toEqual([]);
    expect(fs.chmodCalls).toEqual(
      chain.map((path) => ({ path, mode: PRIVATE_DIR_MODE })),
    );
    for (const dir of chain) {
      expect(fs.entries.get(dir)?.mode).toBe(PRIVATE_DIR_MODE);
    }
  });

  it("leaves an already-private tree untouched", () => {
    const fs = fakeFs({
      [chain[0]]: ownedDir(0o700),
      [chain[1]]: ownedDir(0o700),
    });
    hardenStateDirs(chain, fs.deps);
    expect(fs.mkdirCalls).toEqual([]);
    expect(fs.chmodCalls).toEqual([]);
  });

  it("refuses a symlinked directory instead of following it", () => {
    const fs = fakeFs({
      [chain[0]]: ownedDir(),
      [chain[1]]: { kind: "symlink", mode: 0o777, uid: UID },
    });
    expect(() => hardenStateDirs(chain, fs.deps)).toThrowError(StateDirError);
    expect(() => hardenStateDirs(chain, fs.deps)).toThrow(/symlink/);
    expect(fs.chmodCalls).toEqual([]);
  });

  it("refuses a non-directory path", () => {
    const fs = fakeFs({
      [chain[0]]: ownedDir(),
      [chain[1]]: { kind: "file", mode: 0o600, uid: UID },
    });
    expect(() => hardenStateDirs(chain, fs.deps)).toThrow(/not a directory/);
  });

  it("refuses a foreign-owned directory and does not chmod it", () => {
    // chmod on a directory we do not own either fails or, worse, succeeds on
    // a path an attacker chose — so ownership is checked before any repair.
    const fs = fakeFs({
      [chain[0]]: ownedDir(),
      [chain[1]]: { kind: "dir", mode: 0o777, uid: UID + 1 },
    });
    expect(() => hardenStateDirs(chain, fs.deps)).toThrow(
      /owned by uid 502, not this user \(uid 501\)/,
    );
    expect(fs.chmodCalls).toEqual([]);
    expect(fs.entries.get(chain[1])?.mode).toBe(0o777);
  });

  it("fails closed when lstat raises a non-ENOENT error", () => {
    const fs = fakeFs();
    const lstat = fs.deps.lstat;
    fs.deps.lstat = (path) => {
      if (path === chain[1])
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return lstat(path);
    };
    expect(() => hardenStateDirs(chain, fs.deps)).toThrow(/Cannot inspect/);
  });

  it("fails closed when mkdir raises a non-ENOENT error", () => {
    const fs = fakeFs();
    fs.deps.mkdir = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(() => hardenStateDirs(chain, fs.deps)).toThrow(/Cannot create/);
  });

  it("accepts a directory a concurrent creator made between stat and mkdir", () => {
    const fs = fakeFs();
    // The race the re-read exists for: our lstat said ENOENT, another process
    // created the directory, and our own mkdir then reports EEXIST. Treating
    // that as fatal made two bridges starting at once for different sessions —
    // sharing a missing `sessions/` parent — fail one of them for no reason.
    fs.deps.mkdir = (path: string, mode: number) => {
      fs.entries.set(path, { kind: "dir", mode, uid: UID });
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    };
    expect(() => hardenStateDirs(chain, fs.deps)).not.toThrow();
    expect(fs.entries.get(chain[1])?.mode).toBe(PRIVATE_DIR_MODE);
  });

  it("still validates a directory that appeared during the race", () => {
    const fs = fakeFs();
    // Winning the race is not a free pass: the directory the other process made
    // is inspected like any other, and tightened when it is too open.
    fs.deps.mkdir = (path: string) => {
      fs.entries.set(path, { kind: "dir", mode: 0o755, uid: UID });
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    };
    expect(() => hardenStateDirs(chain, fs.deps)).not.toThrow();
    expect(fs.chmodCalls.map((call) => call.path)).toEqual(chain);
    expect(fs.entries.get(chain[1])?.mode).toBe(PRIVATE_DIR_MODE);
  });

  it("still refuses a raced directory owned by somebody else", () => {
    const fs = fakeFs();
    fs.deps.mkdir = (path: string) => {
      fs.entries.set(path, {
        kind: "dir",
        mode: PRIVATE_DIR_MODE,
        uid: UID + 1,
      });
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    };
    expect(() => hardenStateDirs(chain, fs.deps)).toThrowError(StateDirError);
    expect(fs.chmodCalls).toEqual([]);
  });

  it("fails closed when chmod cannot apply 700", () => {
    const fs = fakeFs({
      [chain[0]]: ownedDir(),
      [chain[1]]: ownedDir(0o755),
    });
    fs.deps.chmod = () => {
      throw new Error("EPERM");
    };
    expect(() => hardenStateDirs(chain, fs.deps)).toThrow(/Cannot tighten/);
  });

  it("fails closed when the dir is still permissive after chmod", () => {
    // A chmod that reports success but leaves the old mode — the verification
    // re-read is what stands between that and a token written world-readable.
    const fs = fakeFs({
      [chain[0]]: ownedDir(),
      [chain[1]]: ownedDir(0o755),
    });
    fs.deps.chmod = () => {};
    expect(() => hardenStateDirs(chain, fs.deps)).toThrow(
      /still mode 755 after an attempt to set 700/,
    );
  });
});

describe("assertStateDirOwned (POSIX)", () => {
  const chain = ["/home/u/.axis-browser", "/home/u/.axis-browser/sessions"];

  it("accepts an owned chain and skips missing entries", () => {
    const fs = fakeFs({ [chain[0]]: ownedDir(0o755) });
    // 0755 is fine for the read-only check — it asserts ownership, not mode.
    expect(() => assertStateDirOwned(chain, fs.deps)).not.toThrow();
  });

  it("refuses a symlink in the chain", () => {
    const fs = fakeFs({
      [chain[0]]: ownedDir(),
      [chain[1]]: { kind: "symlink", mode: 0o777, uid: UID },
    });
    expect(() => assertStateDirOwned(chain, fs.deps)).toThrow(
      /it is a symlink/,
    );
  });

  it("refuses a foreign-owned directory", () => {
    const fs = fakeFs({
      [chain[0]]: ownedDir(),
      [chain[1]]: { kind: "dir", mode: 0o700, uid: UID + 9 },
    });
    expect(() => assertStateDirOwned(chain, fs.deps)).toThrow(
      /owned by uid 510, not this user \(uid 501\)/,
    );
  });

  it("fails closed when lstat raises a non-ENOENT error", () => {
    const fs = fakeFs({ [chain[0]]: ownedDir() });
    fs.deps.lstat = () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    expect(() => assertStateDirOwned(chain, fs.deps)).toThrow(/Cannot inspect/);
  });
});

describe("assertStateDirOwned (Windows)", () => {
  it("is a no-op — a legacy stop does not repair ACLs", () => {
    const lstat = vi.fn();
    expect(() =>
      assertStateDirOwned(["C:\\Users\\u\\.axis-browser"], {
        platform: "win32",
        lstat,
      }),
    ).not.toThrow();
    expect(lstat).not.toHaveBeenCalled();
  });
});

describe("currentUserSid", () => {
  it("picks the SID field by shape from whoami CSV, not by position", () => {
    const runner: ProbeRunner = () =>
      '"laptop\\nites","S-1-5-21-3623811015-3361044348-30300820-1013"';
    expect(currentUserSid(runner)).toBe(
      "S-1-5-21-3623811015-3361044348-30300820-1013",
    );
  });

  it("returns null when whoami fails or has no SID-shaped field", () => {
    expect(currentUserSid(() => null)).toBeNull();
    expect(currentUserSid(() => '"laptop\\nites","User"')).toBeNull();
  });
});

function aclRunner(overrides: Partial<Record<string, ProbeRunner>> = {}): {
  runner: ProbeRunner;
  calls: Array<{ command: string; args: readonly string[] }>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const base: ProbeRunner = (command, args) => {
    calls.push({ command, args });
    if (command === "whoami.exe") return `"laptop\\nites","${USER_SID}"`;
    if (command === "powershell.exe") return `${USER_SID}\r\n${SYSTEM_SID}`;
    if (command === "icacls.exe" && args[1] === "/findsid") {
      const sid = String(args[2]).slice(1);
      // Shaped like a real /findsid hit: the ACE line icacls prints, so the
      // cross-check has to parse it rather than trust the exit code.
      return sid === USER_SID || sid === SYSTEM_SID
        ? `NT AUTHORITY\\SYSTEM:(OI)(CI)F`
        : null;
    }
    return "";
  };
  return {
    calls,
    runner: (command, args) => {
      const override = overrides[command];
      return override ? override(command, args) : base(command, args);
    },
  };
}

describe("Windows ACL verification", () => {
  const chain = ["C:\\Users\\u\\.axis-browser"];
  // These are unit tests of the ACL logic with fake probes on a path that
  // does not exist, so they must not touch the real filesystem either: a real
  // mkdir of `C:\Users\u\...` leaves a literal backslash-named directory on
  // POSIX and fails outright on Windows, where no `C:\Users\u` parent exists.
  // Filesystem behavior is covered separately, in the missing-chain describe
  // below with real temp directories.
  const noMkdir = () => {};

  // On a real Windows host this test would drive the real `whoami.exe` and, on
  // a missing chain, attempt a real mkdir under C:\Users — it exists to prove
  // the non-Windows fallback fails closed, which only means something off
  // Windows.
  it.skipIf(process.platform === "win32")(
    "falls back to the default runner on Windows and still fails closed",
    () => {
      // `publishBridgeCapability` calls hardenStateDirs with no deps at all, so a
      // missing runner cannot be an error — that would make every Windows bridge
      // refuse to start. The default runner is used instead, and because
      // `whoami.exe` does not exist on this platform the SID lookup fails, which is
      // the fail-closed answer the token write depends on. What must never happen
      // is a silent pass or a TypeError.
      expect(() =>
        hardenStateDirs(chain, { platform: "win32", mkdir: noMkdir }),
      ).toThrowError(StateDirError);
      expect(() =>
        hardenStateDirs(chain, { platform: "win32", mkdir: noMkdir }),
      ).toThrow(/current user's SID/);
    },
  );

  it("fails closed when the default runner cannot verify an ACL", () => {
    // Same contract, injected: a runner that answers nothing must produce a
    // StateDirError rather than a directory the token gets written into.
    expect(() =>
      hardenStateDirs(chain, {
        platform: "win32",
        runner: () => null,
        mkdir: noMkdir,
      }),
    ).toThrowError(StateDirError);
  });

  it("does not read a zero-exit 'No ACEs found' banner as a match", () => {
    // A zero exit carrying "No ACEs found" is icacls saying the SID holds
    // nothing. Treating any non-null probe as a match would let that banner
    // satisfy the required-ACE cross-check — exactly the direction that
    // decides whether a token may be written.
    const banner =
      "No ACEs found for user.\r\nSuccessfully processed 1 files; Failed processing 0 files";
    const runner: ProbeRunner = (command) => {
      if (command === "whoami.exe") return `"laptop\\nites","${USER_SID}"`;
      if (command === "powershell.exe") return `${USER_SID}\r\n${SYSTEM_SID}`;
      return banner;
    };
    expect(() =>
      assertWindowsAclPrivate("C:\\Users\\u\\.axis-browser", USER_SID, runner),
    ).toThrow(/cannot find the required ACE/);
  });

  it("repairs each directory's ACL before verifying it", () => {
    const { runner, calls } = aclRunner();
    hardenStateDirs(chain, { platform: "win32", runner, mkdir: noMkdir });

    const icacls = calls.filter((c) => c.command === "icacls.exe");
    // Repair: drop inheritance, strip the well-known groups, grant user + system.
    const repair = icacls.filter((c) => c.args[1] !== "/findsid");
    expect(repair.map((c) => c.args[1])).toEqual([
      "/inheritancelevel:r",
      "/remove:g",
      "/remove:g",
      "/remove:g",
      "/remove:g",
      "/remove:g",
      "/grant:r",
      "/grant:r",
    ]);
    expect(repair.at(-2)?.args[2]).toBe(`*${USER_SID}:(OI)(CI)F`);
    expect(repair.at(-1)?.args[2]).toBe(`*${SYSTEM_SID}:(OI)(CI)F`);
    // Verify: every repair happens before the verification probes.
    const firstVerify = calls.findIndex(
      (c) =>
        c.command === "powershell.exe" ||
        (c.command === "icacls.exe" && c.args[1] === "/findsid"),
    );
    let lastRepair = -1;
    calls.forEach((c, i) => {
      if (c.command === "icacls.exe" && c.args[1] !== "/findsid")
        lastRepair = i;
    });
    expect(firstVerify).toBeGreaterThan(lastRepair);
  });

  it("fails closed when the SID cannot be determined", () => {
    const { runner } = aclRunner({ "whoami.exe": () => null });
    expect(() =>
      hardenStateDirs(chain, { platform: "win32", runner, mkdir: noMkdir }),
    ).toThrow(/Cannot determine the current user's SID/);
  });

  it("fails closed when PowerShell cannot return a readable SID list", () => {
    const { runner } = aclRunner({ "powershell.exe": () => null });
    expect(() =>
      hardenStateDirs(chain, { platform: "win32", runner, mkdir: noMkdir }),
    ).toThrow(/Cannot verify the ACL/);
  });

  it("rejects an ACL that grants access to anyone but the user and LocalSystem", () => {
    const { runner } = aclRunner({
      "powershell.exe": () => `${USER_SID}\r\n${SYSTEM_SID}\r\n${EVERYONE_SID}`,
    });
    expect(() =>
      hardenStateDirs(chain, { platform: "win32", runner, mkdir: noMkdir }),
    ).toThrow(new RegExp(`unexpected: ${EVERYONE_SID}`));
  });

  it("rejects when LocalSystem is missing from the ACL", () => {
    const { runner } = aclRunner({ "powershell.exe": () => USER_SID });
    expect(() =>
      hardenStateDirs(chain, { platform: "win32", runner, mkdir: noMkdir }),
    ).toThrow(new RegExp(`missing: ${SYSTEM_SID}`));
  });

  it("rejects when icacls still finds a forbidden SID the ACL read missed", () => {
    const base: ProbeRunner = (command, args) => {
      if (command === "whoami.exe") return `"u","${USER_SID}"`;
      if (command === "powershell.exe") return `${USER_SID}\r\n${SYSTEM_SID}`;
      if (command === "icacls.exe" && args[1] === "/findsid") {
        // PowerShell lied: icacls still finds Everyone.
        const sid = String(args[2]).slice(1);
        return sid !== "S-1-5-21-1" ? "Everyone:(OI)(CI)F" : null;
      }
      return "";
    };
    expect(() => assertWindowsAclPrivate("C:\\dir", USER_SID, base)).toThrow(
      /still grants access/,
    );
  });

  it("rejects when icacls cannot find a required SID the ACL read reported", () => {
    const runner: ProbeRunner = (command, args) => {
      if (command === "powershell.exe") return `${USER_SID}\r\n${SYSTEM_SID}`;
      if (command === "icacls.exe" && args[1] === "/findsid") {
        return String(args[2]) === `*${USER_SID}` ? `${USER_SID}:(F)` : null;
      }
      return "";
    };
    expect(() => assertWindowsAclPrivate("C:\\dir", USER_SID, runner)).toThrow(
      /icacls cannot find the required ACE/,
    );
  });
});

describe("readWindowsAceSids", () => {
  it("parses SID-shaped lines and dedupes them", () => {
    const runner: ProbeRunner = () =>
      ` ${USER_SID} \r\n${SYSTEM_SID}\nnot-a-sid\n${USER_SID}`;
    expect(readWindowsAceSids("C:\\d", runner)).toEqual([USER_SID, SYSTEM_SID]);
  });

  it("returns null for no output or an unparseable answer", () => {
    expect(readWindowsAceSids("C:\\d", () => null)).toBeNull();
    expect(readWindowsAceSids("C:\\d", () => "no sids here")).toBeNull();
  });
});

describe("repairWindowsAcl / repairWindowsFileAcl", () => {
  it("grants the file without container-inheritance flags", () => {
    const calls: string[][] = [];
    const runner: ProbeRunner = (_command, args) => {
      calls.push([...args]);
      return "";
    };
    repairWindowsFileAcl("C:\\dir\\bridge.pid", USER_SID, runner);
    const grants = calls.filter((a) => a[1] === "/grant:r").map((a) => a[2]);
    expect(grants).toEqual([`*${USER_SID}:F`, `*${SYSTEM_SID}:F`]);
  });

  it("grants the directory with (OI)(CI)F so children inherit", () => {
    const calls: string[][] = [];
    const runner: ProbeRunner = (_command, args) => {
      calls.push([...args]);
      return "";
    };
    repairWindowsAcl("C:\\dir", USER_SID, runner);
    const grants = calls.filter((a) => a[1] === "/grant:r").map((a) => a[2]);
    expect(grants).toEqual([
      `*${USER_SID}:(OI)(CI)F`,
      `*${SYSTEM_SID}:(OI)(CI)F`,
    ]);
  });
});

describe("Windows hardening creates a missing directory chain", () => {
  it("creates each missing directory before repairing its ACL", () => {
    const home = mkdtempSync(join(tmpdir(), "axi-win-chain-"));
    try {
      const chain = [
        join(home, ".axis-browser"),
        join(home, ".axis-browser", "sessions"),
        join(home, ".axis-browser", "sessions", "w1"),
      ];
      const { runner, calls } = aclRunner();
      // A real mkdir, so the test proves the directories actually appear on
      // disk rather than only observing the injected call being made.
      const mkdir = (path: string, mode: number) => mkdirSync(path, { mode });
      expect(() =>
        hardenStateDirs(chain, { platform: "win32", runner, mkdir }),
      ).not.toThrow();
      for (const dir of chain) {
        expect(existsSync(dir), `${dir} should exist after hardening`).toBe(
          true,
        );
      }
      // Creation must precede the ACL work it exists for: the deepest
      // directory gets repaired and verified too, not just created.
      expect(
        calls.some(
          (call) =>
            call.command === "icacls.exe" &&
            call.args[0] === chain[2] &&
            call.args[1] === "/inheritancelevel:r",
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("tolerates an already-existing chain (EEXIST) and still verifies it", () => {
    const home = mkdtempSync(join(tmpdir(), "axi-win-exist-"));
    try {
      const chain = [
        join(home, ".axis-browser"),
        join(home, ".axis-browser", "sessions"),
      ];
      for (const dir of chain) mkdirSync(dir);
      const { runner } = aclRunner();
      // Every mkdir now throws EEXIST — the same concurrent-creator race the
      // POSIX branch tolerates — and hardening must continue to the ACL
      // verification rather than treat it as a failure.
      expect(() =>
        hardenStateDirs(chain, {
          platform: "win32",
          runner,
          mkdir: (path) => mkdirSync(path),
        }),
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a real creation failure as StateDirError", () => {
    const mkdir = () => {
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    };
    const attempt = () =>
      hardenStateDirs(["C:\\Users\\u\\.axis-browser"], {
        platform: "win32",
        runner: aclRunner().runner,
        mkdir,
      });
    expect(attempt).toThrowError(StateDirError);
    expect(attempt).toThrow(/Cannot create the session state directory/);
  });
});
