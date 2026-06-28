import { afterEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

const { callTool } = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock("../src/client.js", () => ({
  CdpError: class CdpError extends AxiError {
    constructor(
      message: string,
      public readonly code: string,
      public readonly suggestions: string[] = [],
    ) {
      super(message, code, suggestions);
    }
  },
  callTool,
  ensureBridge: vi.fn(),
  getSessionSnapshotIfRunning: vi.fn(),
  stopBridge: vi.fn(),
}));

import { main } from "../src/cli.js";
import { CdpError, getSessionSnapshotIfRunning } from "../src/client.js";

describe("main", () => {
  afterEach(() => {
    callTool.mockReset();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("shows bin and description in the no-args home view", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("bin:");
    expect(output).toContain(
      'description: "Axis Browser is a fast, agent-first CLI for Chrome automation and shared CDP workflows. Compatible with `axib` and `chrome-devtools-axi`."',
    );
    expect(output).toContain(
      "browser: no active session",
    );
  });

  it("home view with active session shows metadata but not page content", async () => {
    const snapshot =
      'RootWebArea "My Page"\n  uid=1 heading "Welcome"\n  uid=2 link "About"';
    vi.mocked(getSessionSnapshotIfRunning).mockResolvedValueOnce(snapshot);

    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([]);

    const output = String(write.mock.calls[0]?.[0]);
    // Should show page metadata
    expect(output).toContain("title: My Page");
    expect(output).toContain("refs: 2");
    // Should NOT include the raw snapshot content
    expect(output).not.toContain("snapshot:");
    expect(output).not.toContain("RootWebArea");
    expect(output).not.toContain("uid=1");
    // Should include contextual help for next steps
    expect(output).toContain("help[");
    expect(output).toContain("snapshot");
    expect(output).toContain("--help");
    // Should NOT suggest click without a snapshot visible
    expect(output).not.toContain("click");
  });

  it("rejects an invalid console message id before calling MCP", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main(["console-get", "oops"]);

    expect(callTool).not.toHaveBeenCalled();
    expect(String(write.mock.calls[0]?.[0])).toContain(
      "Invalid console message id: oops",
    );
    expect(process.exitCode).toBe(2);
  });

  it.each([["update"], ["update", "--check"]])(
    "shadows the SDK npm updater for %s",
    async (...argv) => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(argv);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("update: disabled");
      expect(output).toContain("github:Nirmantix/axis-browser");
      expect(output).toContain("upstream, not this fork");
      expect(output).not.toContain("latest published npm version");
      expect(callTool).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("shows Axis update help instead of SDK npm update help", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main(["update", "--help"]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("github:Nirmantix/axis-browser");
    expect(output).toContain("upstream, not Nirmantix/axis-browser");
    expect(output).not.toContain("latest published npm version");
    expect(callTool).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("does not advertise the SDK npm updater in top-level help", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main(["--help"]);

    const output = String(write.mock.calls.map((call) => call[0]).join(""));
    expect(output).toContain("setup hooks");
    expect(output).not.toContain("latest published version");
    expect(output).not.toContain("latest published npm version");
  });

  it("recovers open by creating a page when the browser is not yet connected", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    callTool
      .mockRejectedValueOnce(new CdpError("Not connected", "BROWSER_ERROR"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('RootWebArea "Airlock"\n  uid=1 link "Sign in"');

    await main(["open", "https://airlockhq.com"]);

    expect(callTool.mock.calls).toEqual([
      ["navigate_page", { type: "url", url: "https://airlockhq.com" }],
      ["new_page", { url: "https://airlockhq.com" }],
      ["take_snapshot"],
      [
        "evaluate_script",
        {
          function: expect.stringContaining(
            "__chromeDevtoolsAxiSnapshotGeneration",
          ),
        },
      ],
    ]);
    expect(String(write.mock.calls[0]?.[0])).toContain("title: Airlock");
    expect(String(write.mock.calls[0]?.[0])).toContain(
      'url: "https://airlockhq.com"',
    );
    expect(process.exitCode).toBeUndefined();
  });
});
