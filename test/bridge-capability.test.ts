import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentBridgeToken,
  describeRejectedRequest,
  handleBridgeRequest,
  isAllowedBridgeHost,
  isRequestAllowed,
  publishBridgeCapability,
  setBridgeTokenForTest,
  type BridgeClient,
} from "../src/bridge.js";
import { readProcessIdentity } from "../src/process-identity.js";
import {
  BRIDGE_AUTH_SCHEME,
  BRIDGE_TOKEN_HEADER,
  clearBridgeRecord,
  clearLegacyBridgeRecord,
  isAuthedRecord,
  readBridgeRecord,
  resolveSessionPidFile,
  resolveSessionStateChain,
  type AuthenticatedBridgeRecord,
} from "../src/sessions.js";
import { PRIVATE_FILE_MODE } from "../src/state-dir.js";

/**
 * `publishBridgeCapability` calls `readProcessIdentity(process.pid)` through a
 * direct module import — it exposes no dependency seam of its own — so a
 * module mock is the only way to test the "this process cannot be identified"
 * failure path. The mock delegates to the real implementation; only the test
 * that needs an unidentifiable process stubs a return value. Vitest's
 * mockReset restores this factory implementation (unlike a bare vi.fn()),
 * which is what keeps the delegation intact between tests.
 */
vi.mock("../src/process-identity.js", async () => {
  const original = await vi.importActual<
    typeof import("../src/process-identity.js")
  >("../src/process-identity.js");
  return {
    ...original,
    readProcessIdentity: vi.fn(original.readProcessIdentity),
  };
});

const TEST_TOKEN = "capability-test-token";

interface CapturedResponse {
  statusCode: number;
  body: string;
}

function makeRequest(
  method: string,
  url: string,
  headers: Record<string, string | string[]> = {},
  body?: string,
): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:9224", ...headers };
  if (body !== undefined) {
    req.push(body);
    req.push(null);
  }
  return req;
}

function makeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: "" };
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") captured.body += chunk;
    captured.statusCode = res.statusCode;
    return res;
  }) as typeof res.end;
  return { res, captured };
}

const connectedClient: BridgeClient = {
  listTools: async () => ({ tools: [{ name: "take_snapshot" }] }),
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  close: async () => {},
};

const CAPABILITY_401 = "Missing or invalid bridge capability token";

async function dispatch(
  req: IncomingMessage,
  client: BridgeClient = connectedClient,
): Promise<CapturedResponse> {
  const { res, captured } = makeResponse();
  await handleBridgeRequest(client, req, res);
  return captured;
}

describe("handleBridgeRequest capability gate — unarmed bridge", () => {
  // The window between listen() and publishBridgeCapability() must serve
  // nothing: an unarmed gate refuses every route, never a routed response.
  beforeEach(() => {
    setBridgeTokenForTest(null);
  });
  afterEach(() => {
    setBridgeTokenForTest(null);
  });

  it("answers 401 for /health, /tools, and /call without routing", async () => {
    let clientCalls = 0;
    const spy: BridgeClient = {
      listTools: async () => {
        clientCalls++;
        return { tools: [] };
      },
      callTool: async () => {
        clientCalls++;
        return { content: [] };
      },
      close: async () => {},
    };
    for (const [method, url] of [
      ["GET", "/health"],
      ["GET", "/tools"],
      ["POST", "/call"],
    ] as const) {
      const captured = await dispatch(makeRequest(method, url, {}, "{}"), spy);
      expect(captured.statusCode).toBe(401);
      expect(JSON.parse(captured.body)).toEqual({ error: CAPABILITY_401 });
    }
    expect(clientCalls).toBe(0);
  });

  it("still answers 401 when a presented token cannot match the unarmed gate", async () => {
    const captured = await dispatch(
      makeRequest("GET", "/health", { [BRIDGE_TOKEN_HEADER]: "anything" }),
    );
    expect(captured.statusCode).toBe(401);
  });
});

describe("handleBridgeRequest capability gate — armed bridge", () => {
  beforeEach(() => {
    setBridgeTokenForTest(TEST_TOKEN);
  });
  afterEach(() => {
    setBridgeTokenForTest(null);
  });

  it("answers 401 for a missing token header", async () => {
    const captured = await dispatch(makeRequest("GET", "/tools"));
    expect(captured.statusCode).toBe(401);
    expect(JSON.parse(captured.body)).toEqual({ error: CAPABILITY_401 });
  });

  it("answers 401 for an empty token header", async () => {
    const captured = await dispatch(
      makeRequest("GET", "/tools", { [BRIDGE_TOKEN_HEADER]: "" }),
    );
    expect(captured.statusCode).toBe(401);
    expect(JSON.parse(captured.body)).toEqual({ error: CAPABILITY_401 });
  });

  it("answers 401 for a wrong token of the right length", async () => {
    const captured = await dispatch(
      makeRequest("GET", "/tools", {
        [BRIDGE_TOKEN_HEADER]: "x".repeat(TEST_TOKEN.length),
      }),
    );
    expect(captured.statusCode).toBe(401);
    expect(JSON.parse(captured.body)).toEqual({ error: CAPABILITY_401 });
  });

  it("answers 401 — never 500 — for a wrong-length token (timingSafeEqual must not see it)", async () => {
    for (const wrong of ["short", "x".repeat(4096)]) {
      const captured = await dispatch(
        makeRequest("GET", "/tools", { [BRIDGE_TOKEN_HEADER]: wrong }),
      );
      // timingSafeEqual throws on a length mismatch; the gate must compare
      // lengths first so a malformed guess is a 401, not an unhandled 500.
      expect(captured.statusCode).toBe(401);
      expect(JSON.parse(captured.body)).toEqual({ error: CAPABILITY_401 });
    }
  });

  it("considers only the first value of a repeated token header", async () => {
    // A second bogus value cannot rescue a wrong first value…
    const denied = await dispatch(
      makeRequest("GET", "/tools", {
        [BRIDGE_TOKEN_HEADER]: ["bogus", TEST_TOKEN],
      }),
    );
    expect(denied.statusCode).toBe(401);

    // …and does not spoil a correct first value either.
    const allowed = await dispatch(
      makeRequest("GET", "/tools", {
        [BRIDGE_TOKEN_HEADER]: [TEST_TOKEN, "bogus"],
      }),
    );
    expect(allowed.statusCode).toBe(200);
  });

  it("lets a correct token reach the routes", async () => {
    const health = await dispatch(
      makeRequest("GET", "/health", { [BRIDGE_TOKEN_HEADER]: TEST_TOKEN }),
    );
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toEqual({
      status: "ok",
      auth: BRIDGE_AUTH_SCHEME,
    });

    const tools = await dispatch(
      makeRequest("GET", "/tools", { [BRIDGE_TOKEN_HEADER]: TEST_TOKEN }),
    );
    expect(tools.statusCode).toBe(200);
    expect(JSON.parse(tools.body)).toEqual([{ name: "take_snapshot" }]);

    const call = await dispatch(
      makeRequest(
        "POST",
        "/call",
        { [BRIDGE_TOKEN_HEADER]: TEST_TOKEN },
        JSON.stringify({ name: "take_snapshot" }),
      ),
    );
    expect(call.statusCode).toBe(200);
    expect(JSON.parse(call.body)).toEqual({ result: "ok" });
  });

  it("runs anti-rebinding first: disallowed Host + valid token is still 403", async () => {
    const captured = await dispatch(
      makeRequest("GET", "/health", {
        host: "evil.attacker.com",
        [BRIDGE_TOKEN_HEADER]: TEST_TOKEN,
      }),
    );
    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
  });

  it("answers 403 — not 401 — for a disallowed Host with no token", async () => {
    const captured = await dispatch(
      makeRequest("GET", "/health", { host: "evil.attacker.com" }),
    );
    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
  });
});

describe("describeRejectedRequest", () => {
  it("never logs raw caller values: secrets, CRLF, controls, query, or port", () => {
    // Host carries a control char in the hostname and a secret where the port
    // belongs; the URL carries a secret query; a header carries a secret. The
    // log line must derive everything it prints and leak none of these.
    const req = makeRequest("POST", "/call?token=TOPSECRET&next=/health", {
      host: "evil.attacker.com:TOPSECRET",
      [BRIDGE_TOKEN_HEADER]: "TOPSECRET",
    });
    const description = describeRejectedRequest(req);
    expect(description).not.toContain("TOPSECRET");
    expect(description).not.toContain("/call");
    expect(description).not.toContain("?");
    expect(description).not.toMatch(/[\r\n]/);
    // It does identify the request: method and the hostname the gate parsed.
    expect(description).toBe("Rejected POST: host hostname=evil.attacker.com");
  });

  it("strips CRLF so a forged Host cannot inject log lines", () => {
    const req = makeRequest("GET", "/health", {
      host: "evil.com\r\nInjected: TOPSECRET",
    });
    const description = describeRejectedRequest(req);
    expect(description).not.toContain("\r");
    expect(description).not.toContain("\n");
    expect(description).not.toContain("TOPSECRET");
    // The injected text merges into the hostname field rather than starting a
    // fake line of its own.
    expect(description).toBe("Rejected GET: host hostname=evil.comInjected");
  });

  it("caps an over-long hostname instead of echoing it", () => {
    const req = makeRequest("GET", "/health", { host: "a".repeat(300) });
    const description = describeRejectedRequest(req);
    expect(description).toBe(`Rejected GET: host hostname=${"a".repeat(253)}`);
    expect(description.length).toBeLessThanOrEqual(283);
  });

  it("logs the origin's hostname (lowercased by URL parse) when Host is loopback", () => {
    const req = makeRequest("GET", "/health", {
      host: "127.0.0.1:9224",
      origin: "https://TOPSECRET.evil.example:8443/p?q=TOPSECRET",
    });
    const description = describeRejectedRequest(req);
    expect(description).not.toContain("TOPSECRET");
    expect(description).not.toContain("8443");
    expect(description).not.toContain("?");
    expect(description).toBe(
      "Rejected GET: origin hostname=topsecret.evil.example",
    );
  });

  it("reports an unparseable Origin without echoing it", () => {
    const req = makeRequest("GET", "/health", {
      host: "127.0.0.1:9224",
      origin: "TOPSECRET",
    });
    expect(describeRejectedRequest(req)).toBe(
      "Rejected GET: origin hostname=(unparseable)",
    );
  });

  // A repeated Host header arrives as a string[]. Node's own parser collapses
  // duplicates into a single string, but a proxy or a hand-built request can
  // present an array, and this gate runs *before* the token check — so an
  // unexpected shape has to answer "refuse". It used to reach `.trim()` on the
  // array and throw a TypeError out of the request path instead.
  it("refuses a repeated (array) Host header instead of throwing", () => {
    const req = makeRequest("GET", "/health", {
      host: ["127.0.0.1:9224", "evil.attacker.com"],
    });
    expect(isAllowedBridgeHost(req.headers.host)).toBe(false);
    expect(isRequestAllowed(req)).toBe(false);
    expect(describeRejectedRequest(req)).toContain("Rejected GET");
  });
});

describe("bridge record ownership (clearBridgeRecord / clearLegacyBridgeRecord)", () => {
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "axi-record-"));
    pidFile = join(dir, "bridge.pid");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const authedRecord = (
    pid: number,
    token: string,
  ): AuthenticatedBridgeRecord => ({
    pid,
    port: 9224,
    token,
    startedAt: "Sun Sep 27 00:24:35 2026",
  });

  it("deletes only when pid AND token match — a bind-race loser cannot take the winner's record", () => {
    // The EADDRINUSE loser exits holding its own (different) token; matching
    // on pid alone would still orphan the winner.
    writeFileSync(
      pidFile,
      JSON.stringify(authedRecord(process.pid, "winner-token")),
    );

    clearBridgeRecord({ pid: process.pid, token: "loser-token" }, pidFile);
    expect(existsSync(pidFile)).toBe(true);

    clearBridgeRecord({ pid: process.pid + 1, token: "winner-token" }, pidFile);
    expect(existsSync(pidFile)).toBe(true);

    clearBridgeRecord({ pid: process.pid, token: "winner-token" }, pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("refuses to act on a tokenless legacy record or a malformed file", () => {
    // A legacy record predates tokens; clearBridgeRecord must not delete it —
    // only the explicit, identity-verified stop path may (below).
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: 9224 }));
    clearBridgeRecord({ pid: process.pid, token: "any" }, pidFile);
    expect(existsSync(pidFile)).toBe(true);

    writeFileSync(pidFile, "not json");
    expect(() =>
      clearBridgeRecord({ pid: process.pid, token: "any" }, pidFile),
    ).not.toThrow();
    expect(existsSync(pidFile)).toBe(true);
  });

  it("clearLegacyBridgeRecord deletes a tokenless record for the right pid only", () => {
    writeFileSync(
      pidFile,
      JSON.stringify({ pid: process.pid + 1, port: 9224 }),
    );
    clearLegacyBridgeRecord({ pid: process.pid }, pidFile);
    expect(existsSync(pidFile)).toBe(true);

    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: 9224 }));
    clearLegacyBridgeRecord({ pid: process.pid }, pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("clearLegacyBridgeRecord never deletes an authenticated record", () => {
    // The newer bridge's record survives a legacy cleanup aimed at the same
    // pid — this is what stops `stop` on an old record orphaning a live one.
    writeFileSync(
      pidFile,
      JSON.stringify(authedRecord(process.pid, "winner-token")),
    );
    clearLegacyBridgeRecord({ pid: process.pid }, pidFile);
    expect(existsSync(pidFile)).toBe(true);
  });

  it("treats a missing record as nothing to remove", () => {
    expect(() =>
      clearBridgeRecord({ pid: process.pid, token: "any" }, pidFile),
    ).not.toThrow();
    expect(() =>
      clearLegacyBridgeRecord({ pid: process.pid }, pidFile),
    ).not.toThrow();
    expect(existsSync(pidFile)).toBe(false);
  });
});

// publishBridgeCapability calls hardenStateDirs with no runner dep, and the
// Windows path refuses to run without one — these cases are POSIX-only.
describe.skipIf(process.platform === "win32")("publishBridgeCapability", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-capability-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "capability-worker";
  });

  afterEach(() => {
    setBridgeTokenForTest(null);
    // Vitest restores the factory's delegating implementation on reset.
    vi.mocked(readProcessIdentity).mockReset();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedSession === undefined)
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    rmSync(home, { recursive: true, force: true });
  });

  it("hardens the state dirs, writes an authed 0600 record, and arms the token", () => {
    const chain = resolveSessionStateChain("capability-worker");
    publishBridgeCapability(9225);

    for (const dir of chain) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }

    const record = readBridgeRecord(resolveSessionPidFile("capability-worker"));
    expect(isAuthedRecord(record)).toBe(true);
    expect(record?.pid).toBe(process.pid);
    expect(record?.port).toBe(9225);

    expect(
      statSync(resolveSessionPidFile("capability-worker")).mode & 0o777,
    ).toBe(PRIVATE_FILE_MODE);
    expect(PRIVATE_FILE_MODE).toBe(0o600);

    // The gate and the on-disk record share one token, so a client that
    // read the record can pass the gate this bridge enforces.
    expect(currentBridgeToken()).toBe(record?.token);
    expect(record?.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to publish when the process's own identity cannot be read", () => {
    vi.mocked(readProcessIdentity).mockReturnValueOnce(null);

    expect(() => publishBridgeCapability(9225)).toThrow(/start time/);

    // Fail closed: no record on disk, no armed token. (The hardened
    // directories may exist — creating them private is allowed.)
    const pidFile = resolveSessionPidFile("capability-worker");
    expect(existsSync(pidFile)).toBe(false);
    if (existsSync(join(home, ".axis-browser"))) {
      expect(
        readdirSync(join(home, ".axis-browser"), {
          recursive: true,
        }).filter((entry) => String(entry).endsWith("bridge.pid")),
      ).toHaveLength(0);
    }
    expect(currentBridgeToken()).toBeNull();
  });
});
