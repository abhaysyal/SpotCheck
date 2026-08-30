// On-disk persistence for the annotation queue this server serves over MCP.
// Mirrors Vibe Annotations' own ~/.vibe-annotations/annotations.json
// convention (see docs/features/feature-7-local-mcp-server/spec.md) — the
// server is the source of truth for anything an agent reads; it never
// reaches back into the browser at read time.

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

// Whole-file overwrite, no partial merge — the extension always pushes its
// full current queue on every chrome.storage change, see server.js's /sync
// handler and background.js's push side.
export async function writeAnnotations(annotations) {
  await ensureDir();
  await writeFile(FILE, JSON.stringify(annotations, null, 2), "utf-8");
}
