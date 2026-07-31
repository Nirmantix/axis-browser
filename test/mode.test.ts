import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertSafeUserDataDir,
  defaultManagedProfileDir,
  inferMode,
  resolveMode,
  resolveModeSafe,
  resolveUserDataDir,
} from "../src/mode.js";

const HOME = "/Users/tester";

describe("inferMode — the historical precedence, preserved", () => {
  it("nothing set means a throwaway browser", () => {
    expect(inferMode({})).toBe("ephemeral");
  });

  it("AUTO_CONNECT wins over everything", () => {
    expect(
      inferMode({
        CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "1",
        CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222",
        CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/p",
      }),
    ).toBe("autoconnect");
  });

  it("BROWSER_URL outranks USER_DATA_DIR", () => {
    expect(
      inferMode({
        CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222",
        CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/p",
      }),
    ).toBe("attach");
  });

  it("a profile directory alone means managed", () => {
    expect(inferMode({ CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/p" })).toBe(
      "managed",
    );
  });

  it("this is the exact shape that caused the incident: one stray export forces attach", () => {
    // A globally-exported BROWSER_URL put every shell — including every agent's
    // non-interactive shell — into attach mode against a port nothing served.
    expect(
      inferMode({ CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222" }),
    ).toBe("attach");
  });
});

describe("resolveMode — explicit beats inferred", () => {
  it("an explicit mode overrides what the environment implies", () => {
    expect(
      resolveMode({
        CHROME_DEVTOOLS_AXI_MODE: "ephemeral",
        CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/p",
      }),
    ).toBe("ephemeral");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveMode({ CHROME_DEVTOOLS_AXI_MODE: "  MANAGED " })).toBe(
      "managed",
    );
  });

  it("rejects an unknown mode by name", () => {
    expect(() => resolveMode({ CHROME_DEVTOOLS_AXI_MODE: "headless" })).toThrow(
      /Invalid CHROME_DEVTOOLS_AXI_MODE "headless"/,
    );
  });

  it("refuses attach without a target instead of silently falling back", () => {
    expect(() => resolveMode({ CHROME_DEVTOOLS_AXI_MODE: "attach" })).toThrow(
      /requires CHROME_DEVTOOLS_AXI_BROWSER_URL/,
    );
  });

  it("accepts attach when a target is named", () => {
    expect(
      resolveMode({
        CHROME_DEVTOOLS_AXI_MODE: "attach",
        CHROME_DEVTOOLS_AXI_BROWSER_URL: "ws://127.0.0.1:1234",
      }),
    ).toBe("attach");
  });

  it("managed needs no directory — it defaults one", () => {
    expect(resolveMode({ CHROME_DEVTOOLS_AXI_MODE: "managed" })).toBe(
      "managed",
    );
  });
});

describe("resolveModeSafe — never throws on an error path", () => {
  it("falls back to inference for an invalid mode", () => {
    expect(
      resolveModeSafe({
        CHROME_DEVTOOLS_AXI_MODE: "nonsense",
        CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/p",
      }),
    ).toBe("managed");
  });

  it("falls back for an unsatisfiable attach", () => {
    expect(resolveModeSafe({ CHROME_DEVTOOLS_AXI_MODE: "attach" })).toBe(
      "ephemeral",
    );
  });
});

describe("assertSafeUserDataDir — a human's profile is never an automation profile", () => {
  const chromeDefault = join(
    HOME,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );

  it("refuses the default Chrome profile on macOS", () => {
    expect(() => assertSafeUserDataDir(chromeDefault, HOME, "darwin")).toThrow(
      /Refusing to use/,
    );
  });

  it("refuses a subdirectory of it too", () => {
    expect(() =>
      assertSafeUserDataDir(join(chromeDefault, "Default"), HOME, "darwin"),
    ).toThrow(/Refusing to use/);
  });

  it("explains the silent-no-bind trap rather than just saying no", () => {
    expect(() => assertSafeUserDataDir(chromeDefault, HOME, "darwin")).toThrow(
      /refuses to bind a debugging socket/,
    );
  });

  it("refuses Ulaa's profile — the browser that held 9222 during the incident", () => {
    expect(() =>
      assertSafeUserDataDir(
        join(HOME, "Library", "Application Support", "Ulaa"),
        HOME,
        "darwin",
      ),
    ).toThrow(/Refusing to use/);
  });

  it("refuses the Linux default profile", () => {
    expect(() =>
      assertSafeUserDataDir(
        join(HOME, ".config", "google-chrome"),
        HOME,
        "linux",
      ),
    ).toThrow(/Refusing to use/);
  });

  it("allows a dedicated directory", () => {
    const dir = join(HOME, ".axis-browser-data");
    expect(assertSafeUserDataDir(dir, HOME, "darwin")).toBe(dir);
  });

  it("does not confuse a sibling with a prefix match", () => {
    // "…/Google/ChromeAutomation" must not be treated as inside "…/Google/Chrome".
    const sibling = join(
      HOME,
      "Library",
      "Application Support",
      "Google",
      "ChromeAutomation",
    );
    expect(assertSafeUserDataDir(sibling, HOME, "darwin")).toBe(sibling);
  });
});

describe("resolveUserDataDir", () => {
  it("is null for every mode that owns no profile", () => {
    for (const mode of ["ephemeral", "attach", "autoconnect"] as const) {
      expect(
        resolveUserDataDir(mode, {}, "default", HOME, "darwin"),
      ).toBeNull();
    }
  });

  it("defaults managed mode to a dedicated directory", () => {
    expect(resolveUserDataDir("managed", {}, "default", HOME, "darwin")).toBe(
      defaultManagedProfileDir(HOME),
    );
  });

  it("honours a configured directory for the default session", () => {
    expect(
      resolveUserDataDir(
        "managed",
        { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/axis-profile" },
        "default",
        HOME,
        "darwin",
      ),
    ).toBe("/tmp/axis-profile");
  });

  it("gives a named session its own profile — Chrome locks one profile to one process", () => {
    expect(
      resolveUserDataDir(
        "managed",
        { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/axis-profile" },
        "worker-1",
        HOME,
        "darwin",
      ),
    ).toBe(join("/tmp/axis-profile", "sessions", "worker-1"));
  });

  it("refuses a configured directory inside the real Chrome profile", () => {
    expect(() =>
      resolveUserDataDir(
        "managed",
        {
          CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(
            HOME,
            "Library",
            "Application Support",
            "Google",
            "Chrome",
          ),
        },
        "default",
        HOME,
        "darwin",
      ),
    ).toThrow(/Refusing to use/);
  });
});

describe("assertSafeUserDataDir — symlinks are dereferenced (CodeRabbit #4)", () => {
  // path.resolve is lexical; a symlink must not smuggle a real browser profile past the
  // containment check. This regression needs a real filesystem.
  it("refuses a symlink whose target is inside a real Chrome profile", () => {
    const home = mkdtempSync(join(tmpdir(), "axis-mode-"));
    const chromeProfile = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(chromeProfile, { recursive: true });
    const link = join(home, "sneaky-profile");
    symlinkSync(chromeProfile, link);
    try {
      expect(() => assertSafeUserDataDir(link, home, "darwin")).toThrow(
        /Refusing to use/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
