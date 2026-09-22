// Feature 7 — the local MCP server's access control and persistence.
//
// This spawns the real server.js as a child process rather than importing it:
// the origin policy is enforced by HTTP handlers, the module binds a port and
// reads its config at import time, and a malformed pin is expected to exit
// the process. All three only mean anything end to end.
//
// Two safety measures, because this suite touches real I/O:
//   - HOME/USERPROFILE are redirected to a temp dir, so store.js writes there
//     instead of the developer's own ~/.spotcheck/annotations.json.
//   - SPOTCHECK_EXTENSION_ORIGIN is always set explicitly per child, so a
//     value in the developer's shell can't change what the tests mean. The
//     children run `node server.js` directly, which does not read .env.

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_DIR = new URL("../mcp-server/", import.meta.url);
const SERVER_URL = "http://127.0.0.1:8934";
const EXTENSION_A = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXTENSION_B = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let homeDir;
let child = null;

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "spotcheck-test-"));
});

after(async () => {
  await stopServer();
  await rm(homeDir, { recursive: true, force: true });
});

const storeFile = () => join(homeDir, ".spotcheck", "annotations.json");

function startServer({ pin } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    delete env.SPOTCHECK_EXTENSION_ORIGIN; // never inherit the developer's
    if (pin !== undefined) env.SPOTCHECK_EXTENSION_ORIGIN = pin;

    const proc = spawn(process.execPath, ["server.js"], {
      cwd: SERVER_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;

    let output = "";
    const onData = (buf) => {
      output += buf.toString();
      // "Accepting queue syncs..." is the last line of a successful start;
      // waiting on "listening on" instead raced the policy line.
      if (output.includes("Accepting queue syncs")) resolve({ proc, output: () => output });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      if (output.includes("EADDRINUSE")) {
        reject(
          new Error(
            "Port 8934 is already in use — stop any running SpotCheck MCP server before running these tests."
          )
        );
        return;
      }
      resolve({ proc, output: () => output, exitCode: code });
    });
    setTimeout(() => reject(new Error(`server did not start; output:\n${output}`)), 10000);
  });
}

async function stopServer() {
  if (!child || child.exitCode !== null) {
    child = null;
    return;
  }
  const proc = child;
  child = null;
  await new Promise((resolve) => {
    proc.on("exit", resolve);
    proc.kill();
    setTimeout(resolve, 2000);
  });
  // Give the OS a moment to release the port before the next child binds it.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function sync(origin, body = { annotations: [] }) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return fetch(`${SERVER_URL}/sync`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mcp(origin, payload = { jsonrpc: "2.0", id: 1, method: "tools/list" }) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (origin) headers.Origin = origin;
  return fetch(`${SERVER_URL}/mcp`, { method: "POST", headers, body: JSON.stringify(payload) });
}

const annotation = (overrides = {}) => ({
  id: "a1",
  number: 1,
  selector: "#submit",
  issueType: "spacing",
  note: "Padding looks 4px too tight here.",
  status: "open",
  component: {
    name: "SubmitButton",
    source: "react",
    confidence: "high",
    sourcePath: "src/checkout/SubmitButton.jsx",
    sourceLine: 24,
    ancestry: ["SubmitButton", "CheckoutForm"],
  },
  ...overrides,
});

describe("startup", () => {
  // Each of these starts its own server (or fails to), so they clean up per
  // test rather than per suite.
  afterEach(stopServer);

  test("runs with no configuration at all", async () => {
    const { output } = await startServer();

    // The whole point of making the pin optional: no setup step.
    assert.match(output(), /listening on http:\/\/127\.0\.0\.1:8934/);
    assert.match(output(), /any chrome-extension:\/\/ origin/);
  });

  test("reports the pinned origin when one is configured", async () => {
    const { output } = await startServer({ pin: EXTENSION_A });

    assert.match(output(), new RegExp(`Accepting queue syncs only from: ${EXTENSION_A}`));
  });

  test("refuses to start on a malformed pin rather than rejecting every push", async () => {
    const { output, exitCode } = await startServer({ pin: "typo-no-scheme" });

    // A pin that is set but wrong is a typo, not a preference — and failing
    // loudly is the only way it doesn't look like "sync silently broke."
    assert.equal(exitCode, 1);
    assert.match(output(), /not a chrome-extension:\/\/<id> origin/);
  });
});

describe("/sync origin policy, unpinned", () => {
  after(stopServer);
  before(() => startServer());

  test("accepts any extension origin", async () => {
    const res = await sync(EXTENSION_A);
    assert.equal(res.status, 200);
  });

  test("accepts a second, different extension origin", async () => {
    const res = await sync(EXTENSION_B);
    assert.equal(res.status, 200);
  });

  test("rejects a web page", async () => {
    // The threat that actually matters: any open tab can fetch loopback.
    // The browser sets Origin itself and page script cannot forge it.
    const res = await sync("https://evil.test");
    assert.equal(res.status, 403);
  });

  test("rejects an http page too", async () => {
    const res = await sync("http://localhost:3000");
    assert.equal(res.status, 403);
  });

  test("rejects a request with no Origin header", async () => {
    // The extension's own fetch always sends one, so a missing header is not
    // the extension — it is curl or another local process.
    const res = await sync(null);
    assert.equal(res.status, 403);
  });

  test("rejects a bare 'chrome-extension' prefix that is not an origin", async () => {
    const res = await sync("chrome-extensionevil.test");
    assert.equal(res.status, 403);
  });
});

describe("/sync origin policy, pinned", () => {
  after(stopServer);
  before(() => startServer({ pin: EXTENSION_A }));

  test("accepts the pinned extension", async () => {
    const res = await sync(EXTENSION_A);
    assert.equal(res.status, 200);
  });

  test("rejects a different extension", async () => {
    // The one thing pinning buys over the unpinned default.
    const res = await sync(EXTENSION_B);
    assert.equal(res.status, 403);
  });

  test("still rejects web pages", async () => {
    const res = await sync("https://evil.test");
    assert.equal(res.status, 403);
  });
});

describe("/mcp origin policy", () => {
  after(stopServer);
  before(() => startServer());

  test("serves a local client that sends no Origin", async () => {
    const res = await mcp(null);

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /list_annotations/);
    assert.match(body, /get_annotation/);
  });

  test("rejects a browser extension origin", async () => {
    // Nothing in SpotCheck's extension calls /mcp — background.js only POSTs
    // to /sync — so allowing these left the queue readable by any other
    // installed extension. Regression guard for closing that.
    const res = await mcp(EXTENSION_A);
    assert.equal(res.status, 403);
  });

  test("rejects a web page origin", async () => {
    const res = await mcp("https://evil.test");
    assert.equal(res.status, 403);
  });

  test("refuses GET", async () => {
    const res = await fetch(`${SERVER_URL}/mcp`, { method: "GET" });
    assert.equal(res.status, 405);
  });
});

describe("persistence", () => {
  after(stopServer);
  before(() => startServer());

  test("writes the pushed queue to disk, component and all", async () => {
    const res = await sync(EXTENSION_A, { annotations: [annotation()] });
    assert.equal(res.status, 200);

    const stored = JSON.parse(await readFile(storeFile(), "utf8"));

    assert.equal(stored.length, 1);
    assert.equal(stored[0].note, "Padding looks 4px too tight here.");
    // The source path is the field an agent acts on; it has to survive the
    // round trip intact.
    assert.equal(stored[0].component.sourcePath, "src/checkout/SubmitButton.jsx");
    assert.equal(stored[0].component.sourceLine, 24);
    assert.deepEqual(stored[0].component.ancestry, ["SubmitButton", "CheckoutForm"]);
  });

  test("replaces the whole queue rather than merging into it", async () => {
    await sync(EXTENSION_A, { annotations: [annotation(), annotation({ id: "a2", number: 2 })] });
    await sync(EXTENSION_A, { annotations: [annotation({ id: "a3", number: 3 })] });

    const stored = JSON.parse(await readFile(storeFile(), "utf8"));

    // The extension always pushes its full current queue, so a delete has to
    // actually remove records here.
    assert.deepEqual(
      stored.map((a) => a.id),
      ["a3"]
    );
  });

  test("an empty queue clears the store", async () => {
    await sync(EXTENSION_A, { annotations: [annotation()] });
    await sync(EXTENSION_A, { annotations: [] });

    const stored = JSON.parse(await readFile(storeFile(), "utf8"));

    assert.deepEqual(stored, []);
  });

  test("rejects a malformed body without corrupting the store", async () => {
    await sync(EXTENSION_A, { annotations: [annotation()] });

    const res = await sync(EXTENSION_A, "{not json");

    assert.equal(res.status, 400);
    const stored = JSON.parse(await readFile(storeFile(), "utf8"));
    assert.equal(stored.length, 1); // previous good state intact
  });

  test("a rejected origin never reaches the store", async () => {
    await sync(EXTENSION_A, { annotations: [annotation()] });

    await sync("https://evil.test", { annotations: [annotation({ id: "injected", note: "pwned" })] });

    const stored = JSON.parse(await readFile(storeFile(), "utf8"));
    assert.deepEqual(
      stored.map((a) => a.id),
      ["a1"]
    );
  });
});
