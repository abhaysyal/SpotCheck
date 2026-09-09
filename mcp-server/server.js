// Local MCP server for SpotCheck — a separate Node process, not part of the
// Chrome extension bundle. Receives the annotation queue pushed from
// extension/background.js, persists it to disk (store.js), and exposes it
// read-only over MCP (mcp-tools.js). See
// docs/features/feature-7-local-mcp-server/spec.md for the full design
// rationale, especially the "Security" section this file implements.
//
// Uses the SDK's own createMcpExpressApp() rather than a hand-rolled
// node:http server — it ships built-in DNS-rebinding protection (validates
// the Host header) for exactly the "any tab in any browser window can reach
// a bare localhost port" threat this file is otherwise guarding against by
// hand via Origin checks. Layering both is deliberate, not redundant: the
// SDK's protection covers DNS-rebinding against the Host header; the Origin
// checks below cover a stray tab's fetch() regardless of DNS games.
//
// Stateless MCP mode creates a fresh McpServer + transport pair per request
// (matching the SDK's own official examples/server/simpleStatelessStreamableHttp.js)
// — a single shared transport reused across requests silently breaks after
// the first call, which is not obvious from the constructor/type signatures
// alone and cost real debugging time to discover.

import http from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { writeAnnotations } from "./store.js";
import { listAnnotations, getAnnotation } from "./mcp-tools.js";

const PORT = 8934; // fixed for this pass, see spec.md's "Known limitations"

// Fill this in the moment SpotCheck is published: a Chrome Web Store
// extension's id is fixed and public, so hardcoding it here is safe and
// gives every end user exact-origin matching with zero setup. Until then it
// stays null, because an *unpacked* extension's id varies per machine and
// per checkout — there is no correct value to ship.
const PUBLISHED_EXTENSION_ORIGIN = null;

// An explicit pin, if there is one: the env var (usually from mcp-server/.env)
// wins, then the published id. When neither exists we fall back to accepting
// any chrome-extension:// origin — see isAllowedSyncOrigin below for exactly
// what that does and doesn't protect against.
const EXTENSION_ORIGIN = process.env.SPOTCHECK_EXTENSION_ORIGIN || PUBLISHED_EXTENSION_ORIGIN;
if (process.env.SPOTCHECK_EXTENSION_ORIGIN && !EXTENSION_ORIGIN.startsWith("chrome-extension://")) {
  // Set but malformed is a typo, not a preference — fail loudly rather than
  // silently rejecting every push the extension makes.
  console.error(
    `SPOTCHECK_EXTENSION_ORIGIN is set to "${process.env.SPOTCHECK_EXTENSION_ORIGIN}", which is not a ` +
      "chrome-extension://<id> origin. Fix it or unset it (it is optional). Refusing to start."
  );
  process.exit(1);
}

// The threat this actually defends against is a **web page** — any tab the
// user has open can fetch('http://127.0.0.1:8934/sync') and poison the queue.
// The browser sets Origin itself and page script cannot override it, so
// rejecting everything that isn't a chrome-extension:// origin stops that
// class outright, pin or no pin.
//
// What the pin adds on top is narrow: it stops a *different installed
// extension* from overwriting the queue. It adds nothing against a
// non-browser local process (curl, malware), which can forge any Origin
// header it likes — including a published extension's id, which is public.
// That's the trade being made by defaulting to unpinned: zero setup, in
// exchange for trusting other extensions the user has chosen to install.
function isAllowedSyncOrigin(origin) {
  if (typeof origin !== "string" || !origin.startsWith("chrome-extension://")) return false;
  return EXTENSION_ORIGIN ? origin === EXTENSION_ORIGIN : true;
}

function buildServer() {
  const mcp = new McpServer({ name: "spotcheck", version: "0.1.0" });

  mcp.registerTool(
    "list_annotations",
    { description: "List all SpotCheck annotations (lightweight summaries — no snapshot or tagScopedStyles)" },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await listAnnotations(), null, 2) }],
    })
  );

  mcp.registerTool(
    "get_annotation",
    {
      description: "Get the full captured data for one annotation by id, including tagScopedStyles and snapshot if present",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const annotation = await getAnnotation(id);
        return { content: [{ type: "text", text: JSON.stringify(annotation, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: String(err.message) }], isError: true };
      }
    }
  );

  return mcp;
}

const app = createMcpExpressApp({ host: "127.0.0.1" });

// /sync is handled below, outside Express entirely — createMcpExpressApp()
// registers a global express.json() with the library's default 100KB body
// limit and no way to configure it. That's fine for /mcp's small JSON-RPC
// payloads, but the annotation queue this endpoint receives can carry
// base64-encoded screenshot snapshots and blows past 100KB with just a
// handful of records — verified directly: this threw PayloadTooLargeError
// in real use once a few snapshot-bearing annotations existed. Since
// express.json() runs before any route-specific middleware regardless of
// registration order, the only way to give /sync its own, much larger
// limit is to read its request body manually, before Express's global
// parser ever sees it (see the http.createServer dispatch below).
const SYNC_BODY_LIMIT = 25 * 1024 * 1024; // 25MB — generous for dozens of cropped element screenshots

function handleSync(req, res) {
  // A real webpage's fetch always carries its true page origin and cannot
  // spoof this header, so this is what keeps a stray tab out.
  const origin = req.headers.origin;
  if (!isAllowedSyncOrigin(origin)) {
    console.warn(
      `/sync rejected — origin was "${origin}", expected ` +
        (EXTENSION_ORIGIN ? `"${EXTENSION_ORIGIN}"` : "a chrome-extension:// origin")
    );
    res.writeHead(403).end();
    return;
  }

  let raw = "";
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > SYNC_BODY_LIMIT) {
      tooLarge = true;
      console.warn(`/sync rejected — body exceeded ${SYNC_BODY_LIMIT} bytes`);
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on("end", async () => {
    if (tooLarge) return;
    try {
      const parsed = JSON.parse(raw);
      const annotations = parsed.annotations || [];
      await writeAnnotations(annotations);
      console.log(`/sync accepted — wrote ${annotations.length} annotation(s)`);
      res.writeHead(200, { "Access-Control-Allow-Origin": origin }).end();
    } catch (err) {
      console.error("/sync write failed:", err);
      res.writeHead(400).end(String(err));
    }
  });
}

app.post("/mcp", async (req, res) => {
  // A legitimate MCP client (Claude Code, running locally) never sends a
  // browser Origin header at all. Anything in a browser always does — so
  // reject *every* origin, not just http(s). Nothing in SpotCheck's own
  // extension calls this endpoint (background.js only POSTs to /sync), so
  // allowing chrome-extension:// origins here bought nothing and left the
  // whole annotation queue readable by any other installed extension. This
  // is a second, independent layer on top of createMcpExpressApp's own
  // Host-header DNS-rebinding protection — no token/auth handshake beyond
  // these two checks in this pass (see spec.md).
  const origin = req.headers.origin;
  if (origin) {
    console.warn(`/mcp rejected — request carried a browser Origin header ("${origin}")`);
    res.status(403).end();
    return;
  }

  // Fresh server + transport per request — stateless mode, matching the
  // SDK's own example exactly (see file header comment for why reusing one
  // instance across requests doesn't work).
  const mcp = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      mcp.close();
    });
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/mcp", (req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

// A plain node:http server in front of the Express app, so /sync's request
// stream can be read manually (see handleSync above) before Express's own
// global express.json() middleware — registered inside createMcpExpressApp,
// unconfigurable from here — gets a chance to reject it for size. Every
// other path (/mcp, and anything else) isn't intercepted and falls straight
// through to the Express app unchanged.
//
// Binds to 127.0.0.1 explicitly — never 0.0.0.0, never an externally
// reachable interface. See spec.md's guardrails.
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/sync") {
    handleSync(req, res);
    return;
  }
  app(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`SpotCheck MCP server listening on http://127.0.0.1:${PORT}`);
  console.log(
    EXTENSION_ORIGIN
      ? `Accepting queue syncs only from: ${EXTENSION_ORIGIN}`
      : "Accepting queue syncs from any chrome-extension:// origin (all web pages rejected). " +
          "Set SPOTCHECK_EXTENSION_ORIGIN to pin one extension."
  );
});
