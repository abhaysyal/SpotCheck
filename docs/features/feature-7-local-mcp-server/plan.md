# Feature 7 — Local MCP Server — plan.md

Implementation plan for an AI coding agent. Read `spec.md` first — the architecture (push-from-extension, HTTP transport, Origin-based access control) was researched against a shipped competitor before this plan was written, not assumed; the reasoning there explains *why* each piece below is shaped the way it is.

## Scope reminder

Do **not** implement in this pass:
- Any `resolve`/`reopen` MCP tool, or anything that writes back to the queue from the agent side.
- `watch_annotations`-style long-polling/push-to-agent.
- Filtering, pagination, or search on `list_annotations`.
- An install wizard / published npm package — this is a repo-local dev server for now.
- Any change to `content/queue.js` or `content/annotations.js` — this feature only adds a listener in `background.js` and a new, separate `mcp-server/` directory.

## Files to create / touch

1. **Create** `mcp-server/package.json`, `mcp-server/server.js`, `mcp-server/store.js`, `mcp-server/mcp-tools.js`.
2. **Touch** `extension/background.js` — add the `chrome.storage.onChanged` listener that pushes to the server.
3. **Touch** `CHROMEWEBSTORE.md` — note that a companion local server now exists as an optional, separate component (not shipped inside the extension package, so it doesn't change the Store submission's permissions/data-usage sections — call this out explicitly so it isn't missed at actual submission time).

## Step-by-step

### Step 1 — `mcp-server/package.json`

```json
{
  "name": "spotcheck-mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "express": "^5.2.1",
    "zod": "^3.25.0"
  }
}
```

- `private: true` and no `bin` entry — this is a repo-local dev tool for this pass, not a published package (see `spec.md`'s "Known limitations"). Version pins above are what was actually resolved and verified working (`npm view @modelcontextprotocol/sdk version` at implementation time) — `express` and `zod` are both required directly (not just pulled in transitively by the SDK) since this file's own code imports them.

### Step 2 — `mcp-server/store.js`

```js
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".spotcheck");
const FILE = join(DIR, "annotations.json");

async function ensureDir() {
  await mkdir(DIR, { recursive: true });
}

export async function readAnnotations() {
  try {
    const raw = await readFile(FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function writeAnnotations(annotations) {
  await ensureDir();
  await writeFile(FILE, JSON.stringify(annotations, null, 2), "utf-8");
}
```

- Mirrors Vibe Annotations' own `~/.vibe-annotations/annotations.json` convention (see `spec.md`), swapped to a SpotCheck-specific directory. Whole-file read/write, no partial updates — matches the extension side always pushing its full current array (`spec.md`'s "Data shape" section).

### Step 3 — `mcp-server/mcp-tools.js`

```js
import { readAnnotations } from "./store.js";

// Lightweight — deliberately excludes snapshot/tagScopedStyles, see spec.md.
function summarize(a) {
  return {
    id: a.id,
    number: a.number,
    selector: a.selector,
    issueType: a.issueType,
    note: a.note,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export async function listAnnotations() {
  const all = await readAnnotations();
  return all.map(summarize);
}

export async function getAnnotation(id) {
  const all = await readAnnotations();
  const found = all.find((a) => a.id === id);
  if (!found) throw new Error(`No annotation with id ${id}`);
  return found; // full record — every field Feature 6 captured, see spec.md
}
```

### Step 4 — `mcp-server/server.js`

**Revised from this plan's original draft after actually building and running it against SDK 1.30.0** — two things in the first draft turned out wrong, both discovered empirically, not by re-reading docs harder:

1. **A single shared `McpServer`/`StreamableHTTPServerTransport` pair, reused across requests, breaks after the first call.** The first `initialize` call succeeds; every request after it fails. The SDK's own bundled example (`examples/server/simpleStatelessStreamableHttp.js`, shipped inside the package) creates a **fresh `McpServer` + fresh transport per request** in stateless mode (`sessionIdGenerator: undefined`) — that's the actual supported pattern, not obvious from the constructor signature alone.
2. **Use `createMcpExpressApp()`** (`@modelcontextprotocol/sdk/server/express.js`, also bundled) instead of hand-rolling a raw `node:http` server. It sets up `express.json()` body parsing (needed for `handleRequest(req, res, req.body)`'s third argument) and — genuinely useful, not just convenience — automatically applies **DNS-rebinding protection** (validates the `Host` header) when bound to `127.0.0.1`/`localhost`. That's a second, independent layer against the exact "any tab can reach a bare localhost port" threat this feature's Origin checks were already written to cover; layering both is deliberate.

```js
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { writeAnnotations } from "./store.js";
import { listAnnotations, getAnnotation } from "./mcp-tools.js";

const PORT = 8934; // fixed for this pass, see spec.md's "Known limitations"
const EXTENSION_ORIGIN = process.env.SPOTCHECK_EXTENSION_ORIGIN;
if (!EXTENSION_ORIGIN || !EXTENSION_ORIGIN.startsWith("chrome-extension://")) {
  console.error("SPOTCHECK_EXTENSION_ORIGIN must be set — see spec.md's Security section.");
  process.exit(1);
}

function buildServer() {
  const mcp = new McpServer({ name: "spotcheck", version: "0.1.0" });

  // registerTool, not the older tool(name, description, schema, cb) overload
  // — that one still works in 1.30.0 but is marked @deprecated in the SDK's
  // own types in favor of this shape.
  mcp.registerTool(
    "list_annotations",
    { description: "List all SpotCheck annotations (lightweight summaries — no snapshot or tagScopedStyles)" },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await listAnnotations(), null, 2) }] })
  );

  mcp.registerTool(
    "get_annotation",
    { description: "Get the full captured data for one annotation by id", inputSchema: { id: z.string() } },
    async ({ id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await getAnnotation(id), null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: String(err.message) }], isError: true };
      }
    }
  );

  return mcp;
}

const app = createMcpExpressApp({ host: "127.0.0.1" });

app.post("/sync", async (req, res) => {
  const origin = req.headers.origin;
  if (origin !== EXTENSION_ORIGIN) return res.status(403).end();
  try {
    await writeAnnotations(req.body.annotations || []);
    res.status(200).header("Access-Control-Allow-Origin", origin).end();
  } catch (err) {
    res.status(400).end(String(err));
  }
});

app.post("/mcp", async (req, res) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return res.status(403).end(); // real browser page — reject
  const mcp = buildServer(); // fresh per request — see note above
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => { transport.close(); mcp.close(); });
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

app.get("/mcp", (req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`SpotCheck MCP server listening on http://127.0.0.1:${PORT}`);
});
```

- `SPOTCHECK_EXTENSION_ORIGIN` is read from an env var rather than hardcoded, since an unpacked extension's id is derived from its filesystem path (differs per machine/checkout) while a Chrome-Web-Store-published one has a fixed id — the real id (`chrome-extension://<id>`) is visible on `chrome://extensions` with Developer mode on. The server refuses to start without it, on purpose.
- `express` needs adding as a direct dependency in `package.json` (it's already pulled in transitively by the SDK itself, since `express.js` imports it, but declare it explicitly since this file imports it too).

### Step 5 — `extension/background.js`: push on change

Add near the existing listeners (after the `SPOTCHECK_SET_ACTIVE` toggle listener and the screenshot-capture listener Feature 6 added):

```js
// Feature 7 — pushes the annotation queue to the local MCP server whenever
// it changes, regardless of which context wrote it (content/queue.js runs
// in the page's isolated world and has no way to reach this URL itself —
// see spec.md for why the extension pushes rather than the server pulling).
const MCP_SERVER_URL = "http://127.0.0.1:8934";

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.spotcheck_annotations) return;
  const annotations = changes.spotcheck_annotations.newValue || [];
  fetch(`${MCP_SERVER_URL}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations }),
  }).catch(() => {}); // server not running — fail silently, must never affect the extension's own behavior
});
```

- No changes needed to `content/queue.js` at all — `chrome.storage.onChanged` fires for every extension context on any `chrome.storage.local` write, including ones made from a content script's isolated world. This is the whole reason this feature can avoid touching Feature 6's files.
- **`manifest.json` needs one addition this plan's first draft got wrong**: `"host_permissions": ["http://127.0.0.1/*"]`. Verified directly — without it, this exact `fetch()` call from `background.js` failed with a bare `TypeError: Failed to fetch`, while the identical request from `curl` against the same running server succeeded. See `spec.md`'s corrected "Security"/guardrails notes.

## Test criteria before calling this feature done

- [ ] With the server not running at all, every existing extension behavior (annotate, hot-save, export, delete) works exactly as before — confirm no error surfaces anywhere in the page or extension console beyond the expected, swallowed `fetch` rejection.
- [ ] Start the server (`node mcp-server/server.js` with `SPOTCHECK_EXTENSION_ORIGIN` set to the actual loaded-unpacked extension's real `chrome-extension://<id>` origin). Create an annotation in the browser — confirm `~/.spotcheck/annotations.json` updates within roughly a second.
- [ ] Edit an existing annotation (hot-save) — confirm the on-disk file updates again, reflecting the edit, without creating a duplicate entry.
- [ ] Delete an annotation — confirm it disappears from the on-disk file too.
- [ ] From a terminal (or `claude mcp add --transport http spotcheck http://127.0.0.1:8934/mcp` + asking Claude Code directly), call `list_annotations` — confirm it returns lightweight summaries only (no `snapshot`/`tagScopedStyles` fields present).
- [ ] Call `get_annotation` with a real id from that list — confirm the full record comes back, including `tagScopedStyles` and (if that annotation has one) `snapshot`.
- [ ] Call `get_annotation` with a made-up id — confirm a clean error, not a crash or a hung request.
- [ ] From a **regular webpage's own console** (any tab, not the extension), attempt `fetch('http://127.0.0.1:8934/sync', { method: 'POST', body: '{}' })` and `fetch('http://127.0.0.1:8934/mcp')` — confirm both are rejected (403), proving the Origin checks actually hold against exactly the attack class `spec.md` describes, not just against a well-behaved caller.
- [ ] Confirm the server never attempts to bind to `0.0.0.0` or any non-loopback interface — inspect the `listen()` call, don't just trust that it "seems to work" from `localhost`.
- [ ] Confirm zero requests to anything other than `127.0.0.1` appear in the server process's own network activity (no accidental telemetry, no dependency phoning home) — check what `@modelcontextprotocol/sdk` itself does on startup if anything, since that's a new third-party dependency this feature introduces that the rest of the project doesn't have.
