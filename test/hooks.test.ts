import { describe, it, expect, vi } from "vitest";

const { installSessionStartHooks } = vi.hoisted(() => ({
  installSessionStartHooks: vi.fn(),
}));

vi.mock("axi-sdk-js", async () => {
  const actual =
    await vi.importActual<typeof import("axi-sdk-js")>("axi-sdk-js");
  return {
    ...actual,
    installSessionStartHooks,
  };
});

import {
  computeCodexConfigUpdate,
  computeSessionStartHookUpdate,
  type HookSettings,
} from "axi-sdk-js";
import {
  installHooksOrThrow,
  shouldInstallHooksForExecPath,
  stripLegacyManagedHooks,
} from "../src/hooks.js";

/** Must match src/hooks.ts. */
const HOOK_MARKER = "axis-browser";

/**
 * Mirrors the spec `installHooksOrThrow` hands the SDK. These stay contract
 * tests for the hook behavior the CLI depends on — src/hooks.ts used to wrap
 * this call, but nothing in production ever called the wrapper, so the tests
 * drive the SDK directly rather than a shim kept alive only for them.
 */
function computeHookUpdate(
  settings: HookSettings,
  execPath: string,
): [HookSettings, boolean] {
  return computeSessionStartHookUpdate(settings, {
    marker: HOOK_MARKER,
    command: execPath,
    timeoutSeconds: 10,
  }) as [HookSettings, boolean];
}

describe("installHooksOrThrow", () => {
  it("throws when the hook installer reports an internal install error", () => {
    installSessionStartHooks.mockImplementationOnce((options) => {
      options.onError?.("/home/user/.claude/settings.json: permission denied");
    });

    expect(() => installHooksOrThrow()).toThrow(
      "/home/user/.claude/settings.json: permission denied",
    );
  });
});

describe("computeHookUpdate", () => {
  it("installs hook when settings have no hooks", () => {
    const settings = {};
    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/axis-browser",
    );
    expect(changed).toBe(true);
    expect(updated.hooks).toBeDefined();
    expect(updated.hooks!.SessionStart).toBeDefined();
    expect(updated.hooks!.SessionStart!.length).toBeGreaterThan(0);
    const hookCmd = JSON.stringify(updated);
    expect(hookCmd).toContain("axis-browser");
  });

  it("installs hook alongside existing hooks", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "other-tool status",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/axis-browser",
    );
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("other-tool status");
    expect(str).toContain("axis-browser");
  });

  it("is a no-op when hook exists with correct path", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "/usr/bin/axis-browser",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [, changed] = computeHookUpdate(settings, "/usr/bin/axis-browser");
    expect(changed).toBe(false);
  });

  it("repairs hook when executable path changed", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "/old/path/axis-browser",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/new/path/axis-browser",
    );
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("/new/path/axis-browser");
    expect(str).not.toContain("/old/path/");
  });

  it("preserves other event hooks", () => {
    const settings = {
      hooks: {
        SessionEnd: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "cleanup-tool run",
                timeout: 5,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/axis-browser",
    );
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("cleanup-tool run");
    expect(str).toContain("axis-browser");
  });

  it("repairs hooks regardless of whether the exec path is production-eligible", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "/usr/local/bin/axis-browser",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/Users/test/worktrees/axis-browser/pool-3/bin/chrome-devtools-axi.ts",
    );
    expect(changed).toBe(true);
    expect(JSON.stringify(updated)).toContain(
      "/Users/test/worktrees/axis-browser/pool-3/bin/chrome-devtools-axi.ts",
    );
  });
});

describe("shouldInstallHooksForExecPath", () => {
  it("rejects non-production TypeScript entrypoints", () => {
    expect(
      shouldInstallHooksForExecPath(
        "/Users/test/worktrees/axis-browser/pool-3/bin/chrome-devtools-axi.ts",
      ),
    ).toBe(false);
  });

  it("accepts packaged dist entrypoints", () => {
    expect(
      shouldInstallHooksForExecPath(
        "/Users/test/github/Nirmantix/axis-browser/dist/bin/chrome-devtools-axi.js",
      ),
    ).toBe(true);
  });
});

describe("stripLegacyManagedHooks", () => {
  const legacyGroup = (command: string) => ({
    matcher: "",
    hooks: [{ type: "command", command, timeout: 10 }],
  });

  it("removes a hook installed under the previous marker", () => {
    const [updated, changed] = stripLegacyManagedHooks({
      hooks: { SessionStart: [legacyGroup("/usr/bin/chrome-devtools-axi")] },
    });
    expect(changed).toBe(true);
    expect(JSON.stringify(updated)).not.toContain("chrome-devtools-axi");
  });

  it("upgrading does not leave both markers firing", () => {
    // The regression this exists for: the SDK only strips entries matching the
    // *current* marker, so without this pass an upgrade ran two session hooks.
    const [updated, changed] = stripLegacyManagedHooks({
      hooks: {
        SessionStart: [
          legacyGroup("/usr/bin/chrome-devtools-axi"),
          legacyGroup("/usr/bin/axis-browser"),
        ],
      },
    });
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).not.toContain("chrome-devtools-axi");
    expect(str).toContain("/usr/bin/axis-browser");
  });

  it("leaves the current marker's hooks alone", () => {
    const settings = {
      hooks: { SessionStart: [legacyGroup("/usr/bin/axis-browser")] },
    };
    const [updated, changed] = stripLegacyManagedHooks(settings);
    expect(changed).toBe(false);
    expect(updated).toBe(settings);
  });

  it("does not touch unrelated hooks, including chrome-devtools-mcp", () => {
    const settings = {
      hooks: {
        SessionStart: [
          legacyGroup("npx -y chrome-devtools-mcp@latest"),
          legacyGroup("other-tool status"),
        ],
      },
    };
    const [updated, changed] = stripLegacyManagedHooks(settings);
    expect(changed).toBe(false);
    expect(updated).toBe(settings);
  });

  it("preserves sibling hooks inside a shared group", () => {
    const [updated, changed] = stripLegacyManagedHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "/usr/bin/chrome-devtools-axi" },
              { type: "command", command: "keep-me run" },
            ],
          },
        ],
      },
    });
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("keep-me run");
    expect(str).not.toContain("chrome-devtools-axi");
  });

  it("drops a group left empty and preserves other settings keys", () => {
    const [updated, changed] = stripLegacyManagedHooks({
      model: "opus",
      hooks: { SessionStart: [legacyGroup("/usr/bin/chrome-devtools-axi")] },
    });
    expect(changed).toBe(true);
    expect(updated.hooks!.SessionStart).toEqual([]);
    expect(updated.model).toBe("opus");
  });

  it("is a no-op when there are no SessionStart hooks", () => {
    const settings = {};
    const [updated, changed] = stripLegacyManagedHooks(settings);
    expect(changed).toBe(false);
    expect(updated).toBe(settings);
  });
});

describe("computeCodexConfigUpdate", () => {
  it("creates a features section when config is empty", () => {
    const [updated, changed] = computeCodexConfigUpdate("");
    expect(changed).toBe(true);
    expect(updated).toBe("[features]\nhooks = true\n");
  });

  it("adds hooks when features section exists", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\nother = true\n",
    );
    expect(changed).toBe(true);
    expect(updated).toContain("[features]");
    expect(updated).toContain("other = true");
    expect(updated).toContain("hooks = true");
  });

  it("repairs hooks when disabled", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\nhooks = false\n",
    );
    expect(changed).toBe(true);
    expect(updated).toContain("hooks = true");
    expect(updated).not.toContain("hooks = false");
  });

  it("is a no-op when hooks is already enabled", () => {
    const original = "[features]\nhooks = true\n";
    const [updated, changed] = computeCodexConfigUpdate(original);
    expect(changed).toBe(false);
    expect(updated).toBe(original);
  });

  it("preserves unrelated sections while adding the flag", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      '[model]\nname = "gpt-5"\n',
    );
    expect(changed).toBe(true);
    expect(updated).toContain("[model]");
    expect(updated).toContain('name = "gpt-5"');
    expect(updated).toContain("[features]");
    expect(updated).toContain("hooks = true");
  });

  it("inserts before a following array-of-tables header", () => {
    const input = '[features]\nother = true\n[[profiles]]\nname = "default"\n';
    const [updated, changed] = computeCodexConfigUpdate(input);
    expect(changed).toBe(true);
    expect(updated).toBe(
      '[features]\nother = true\nhooks = true\n[[profiles]]\nname = "default"\n',
    );
  });
});
