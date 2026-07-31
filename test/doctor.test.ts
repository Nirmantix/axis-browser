import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport, readProfileLock } from "../src/doctor.js";

describe("readProfileLock — Chrome's one-process-per-profile lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "axi-profile-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports unlocked when there is no lock", () => {
    expect(readProfileLock(dir)).toEqual({ locked: false });
  });

  it("reports locked when the naming process is alive", () => {
    symlinkSync(`somehost-${process.pid}`, join(dir, "SingletonLock"));
    expect(readProfileLock(dir)).toMatchObject({ locked: true });
  });

  it("treats a stale lock as unlocked — that is the case where a relaunch just works", () => {
    symlinkSync("somehost-999999", join(dir, "SingletonLock"));
    expect(readProfileLock(dir, () => false)).toEqual({ locked: false });
  });
});

describe("buildDoctorReport", () => {
  let home: string;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-doctor-"));
    mkdirSync(join(home, ".axis-browser"), { recursive: true });
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
  });
  afterEach(() => {
    if (savedSession === undefined)
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    rmSync(home, { recursive: true, force: true });
  });

  const deps = (probeResult: unknown) => ({
    probe: async () => probeResult as never,
    health: async () => true,
    home,
    platform: "darwin" as NodeJS.Platform,
  });

  it("reports the mode explicitly — the thing no diagnostic said during the incident", async () => {
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(home, "profile") },
      deps({ ok: true }),
    );
    expect(report.mode).toBe("managed");
  });

  it("fails a dead attach endpoint and names the holder", async () => {
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222" },
      deps({
        ok: false,
        reason: "NOT_CDP",
        detail: "HTTP 404",
        holder: { pid: 4242, command: "Ulaa" },
      }),
    );

    expect(report.status).toBe("error");
    expect(report.mode).toBe("attach");
    expect(report.endpoint).toMatchObject({ ok: false, reason: "NOT_CDP" });
    expect(report.blockers.join("\n")).toContain("Ulaa");
  });

  it("marks the one case a human must rule on, and no other", async () => {
    const held = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222" },
      deps({
        ok: false,
        reason: "NOT_CDP",
        holder: { pid: 4242, command: "Ulaa" },
      }),
    );
    expect(held.blockers).toContain("PORT_HELD_BY_FOREIGN_PROCESS");

    const empty = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222" },
      deps({ ok: false, reason: "NO_LISTENER" }),
    );
    // Nothing is listening: axis can fix this itself, so it must NOT ask a human.
    expect(empty.blockers).not.toContain("PORT_HELD_BY_FOREIGN_PROCESS");
  });

  it("tells the agent not to ask for credentials", async () => {
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222" },
      deps({ ok: false, reason: "NO_LISTENER" }),
    );
    expect(report.blockers.join("\n")).toContain(
      "Local CDP has no authentication",
    );
  });

  it("emits remedies that are runnable commands, not prose", async () => {
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222" },
      deps({ ok: false, reason: "NO_LISTENER" }),
    );
    expect(report.remedies.length).toBeGreaterThan(0);
    for (const remedy of report.remedies) {
      // An agent should be able to paste any of these into a shell verbatim.
      expect(remedy).toMatch(
        /^(axis-browser|unset|export|rm |CHROME_DEVTOOLS_AXI_)/,
      );
      expect(remedy).not.toMatch(/\b(should|please|try to|consider)\b/i);
    }
  });

  it("does not probe an endpoint in a launch mode", async () => {
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_MODE: "ephemeral" },
      {
        probe: async () => {
          throw new Error("must not probe in ephemeral mode");
        },
        health: async () => true,
        home,
        platform: "darwin",
      },
    );
    expect(report.endpoint).toBeUndefined();
  });

  it("reports a ws endpoint as unprobed rather than claiming it verified it", async () => {
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_BROWSER_URL: "ws://127.0.0.1:1234/x" },
      {
        probe: async () => {
          throw new Error("ws endpoints expose no /json/version");
        },
        health: async () => true,
        home,
        platform: "darwin",
      },
    );
    expect(report.endpoint?.browser).toContain("not probed");
  });

  it("does not flag a profile lock held by this session's own healthy bridge", async () => {
    // Caught live: managed mode reported its own running browser as a blocker.
    // Reporting normal operation as a problem trains readers to ignore the field.
    const profile = join(home, "locked-profile");
    mkdirSync(profile, { recursive: true });
    symlinkSync(`somehost-${process.pid}`, join(profile, "SingletonLock"));

    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: profile },
      { ...deps({ ok: true }), health: async () => true },
    );
    expect(report.profile?.locked).toBe(true);
    expect(report.blockers.join("\n")).not.toContain(
      "locked by another Chrome",
    );
  });

  it("does flag a profile lock when this session's bridge is not answering", async () => {
    const profile = join(home, "stuck-profile");
    mkdirSync(profile, { recursive: true });
    symlinkSync(`somehost-${process.pid}`, join(profile, "SingletonLock"));

    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: profile },
      { ...deps({ ok: true }), health: async () => false },
    );
    expect(report.blockers.join("\n")).toContain("locked by another Chrome");
  });

  it("surfaces an unreadable PID file and says auto-reap is suppressed", async () => {
    // Silent disablement is how a safety mechanism rots: if an unparseable PID file
    // switches automatic reaping off, doctor has to say so.
    writeFileSync(join(home, ".axis-browser", "bridge.pid"), "{truncated");

    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_MODE: "ephemeral" },
      { ...deps({ ok: true }), health: async () => true },
    );
    expect(report.malformedPidFiles).toHaveLength(1);
    expect(report.blockers.join("\n")).toContain(
      "Automatic reaping is suppressed",
    );
    expect(report.remedies.some((r) => r.startsWith("rm "))).toBe(true);
  });

  it("reports an invalid session name instead of dying on it", async () => {
    // doctor exists to report misconfiguration; resolveSessionName throws on a bad
    // CHROME_DEVTOOLS_AXI_SESSION, which killed the command with a raw stack trace.
    // Supplied through the report's own env — not process.env — so this also pins
    // that session resolution honours the env buildDoctorReport was given.
    const report = await buildDoctorReport(
      {
        CHROME_DEVTOOLS_AXI_MODE: "ephemeral",
        CHROME_DEVTOOLS_AXI_SESSION: "../../etc",
      },
      deps({ ok: true }),
    );
    expect(report.status).toBe("error");
    expect(report.blockers.join("\n")).toContain("CHROME_DEVTOOLS_AXI_SESSION");
    expect(report.remedies).toContain("unset CHROME_DEVTOOLS_AXI_SESSION");
  });

  it("flags a managed profile that has never been used as needing a login", async () => {
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(home, "never-used") },
      deps({ ok: true }),
    );
    expect(report.blockers.join("\n")).toContain("NEEDS_INTERACTIVE_LOGIN");
    expect(report.remedies).toContain("axis-browser login <url>");
  });

  it("refuses a managed profile pointed at the real Chrome profile", async () => {
    const report = await buildDoctorReport(
      {
        CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(
          home,
          "Library",
          "Application Support",
          "Google",
          "Chrome",
        ),
      },
      deps({ ok: true }),
    );
    expect(report.status).toBe("error");
    expect(report.blockers.join("\n")).toContain("Refusing to use");
  });
});
