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
  const savedHome = process.env.HOME;
  const savedPort = process.env.CHROME_DEVTOOLS_AXI_PORT;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-doctor-"));
    mkdirSync(join(home, ".axis-browser"), { recursive: true });
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    // readBridgeRecord/scanSessionPidFiles resolve through homedir(), not the
    // injected home — sandbox HOME so a stray real record cannot leak in.
    process.env.HOME = home;
  });
  afterEach(() => {
    if (savedSession === undefined)
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPort === undefined) delete process.env.CHROME_DEVTOOLS_AXI_PORT;
    else process.env.CHROME_DEVTOOLS_AXI_PORT = savedPort;
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

  it("presents the record's capability token to the health probe", async () => {
    // The bridge 401s unauthenticated /health: doctor must arm itself from the
    // same record every other RPC path reads, or it reports its own healthy
    // bridge as broken.
    writeFileSync(
      join(home, ".axis-browser", "bridge.pid"),
      JSON.stringify({
        pid: process.pid,
        port: 9871,
        token: "record-token",
        startedAt: "t",
      }),
    );
    const seen: { port?: number; token?: string; session?: string } = {};
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_MODE: "ephemeral" },
      {
        ...deps({ ok: true }),
        health: async (
          port: number,
          opts?: { expectedSession?: string; token?: string },
        ) => {
          seen.port = port;
          seen.session = opts?.expectedSession;
          seen.token = opts?.token;
          return true;
        },
      },
    );
    expect(seen).toEqual({
      port: report.session.port,
      session: "default",
      token: "record-token",
    });
  });

  it("probes without a token when the record predates capability tokens", async () => {
    writeFileSync(
      join(home, ".axis-browser", "bridge.pid"),
      JSON.stringify({ pid: process.pid, port: 9871 }),
    );
    const tokens: (string | undefined)[] = [];
    await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_MODE: "ephemeral" },
      {
        ...deps({ ok: true }),
        health: async (_port: number, opts?: { token?: string }) => {
          tokens.push(opts?.token);
          return true;
        },
      },
    );
    expect(tokens).toEqual([undefined]);
  });

  it("warns on a tokenless record and prescribes the verified stop", async () => {
    // The record names a live bridge this CLI cannot authenticate to; `stop`
    // is the only sanctioned retirement path.
    writeFileSync(
      join(home, ".axis-browser", "bridge.pid"),
      JSON.stringify({ pid: process.pid, port: 9871 }),
    );
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_MODE: "ephemeral" },
      deps({ ok: true }),
    );
    expect(report.status).toBe("warn");
    expect(report.blockers.join("\n")).toContain("predates capability tokens");
    expect(report.remedies.some((r) => r.startsWith("axis-browser stop"))).toBe(
      true,
    );
  });

  it("reports an invalid CHROME_DEVTOOLS_AXI_PORT as a blocker, not a crash", async () => {
    // resolveSessionPort throws on a bad override; doctor converts that into the
    // misconfiguration report it exists to produce. Supplied through the report's
    // own env, exactly like the session name below.
    const report = await buildDoctorReport(
      {
        CHROME_DEVTOOLS_AXI_MODE: "ephemeral",
        CHROME_DEVTOOLS_AXI_PORT: "not-a-port",
      },
      deps({ ok: true }),
    );
    expect(report.status).toBe("error");
    expect(report.blockers.join("\n")).toContain(
      'Invalid CHROME_DEVTOOLS_AXI_PORT "not-a-port"',
    );
    expect(report.remedies).toContain("unset CHROME_DEVTOOLS_AXI_PORT");
    // Falls back to the session's own port so the rest of the report still runs.
    expect(report.session.port).toBe(9224);
  });

  it("diagnoses the env it was handed, not the ambient process.env", async () => {
    // The port used to be the one setting doctor still read from process.env, so
    // a bad value in the operator's shell leaked into a report built for a
    // different environment — and a *good* value there was silently ignored.
    // Restored in afterEach.
    process.env.CHROME_DEVTOOLS_AXI_PORT = "not-a-port";
    const report = await buildDoctorReport(
      { CHROME_DEVTOOLS_AXI_MODE: "ephemeral" },
      deps({ ok: true }),
    );
    expect(report.blockers.join("\n")).not.toContain("not-a-port");
    expect(report.session.port).toBe(9224);
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
