#!/usr/bin/env node
/**
 * Wait until search-docs index queue is drained (for Environment snapshot prep).
 * Usage: node scripts/cloud-agent/wait-search-docs-index.mjs
 * Prerequisite: search-docs server already running (e.g. server start).
 */
import { spawnSync } from "child_process";

const CLI = process.env.SEARCH_DOCS_CLI ?? "@search-docs/cli@1.3.1";
const MAX_WAIT_MS = Number(process.env.SEARCH_DOCS_INDEX_WAIT_MS ?? 30 * 60 * 1000);
const POLL_MS = Number(process.env.SEARCH_DOCS_INDEX_POLL_MS ?? 5000);

function sleep(ms) {
  spawnSync("sleep", [String(Math.ceil(ms / 1000))]);
}

function runStatus() {
  const r = spawnSync("npx", ["-y", CLI, "server", "status"], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  return r.stdout + r.stderr;
}

const start = Date.now();
let lastLine = "";

while (Date.now() - start < MAX_WAIT_MS) {
  const out = runStatus();
  const queue = out.match(/Queue:\s*(\d+)/);
  const processing = out.match(/Processing:\s*(\d+)/);
  const docs = out.match(/Total Documents:\s*(\d+)/);
  const q = queue ? Number(queue[1]) : NaN;
  const p = processing ? Number(processing[1]) : NaN;
  const d = docs ? Number(docs[1]) : NaN;
  lastLine = `documents=${d} queue=${q} processing=${p}`;
  process.stderr.write(`[wait-search-docs-index] ${lastLine}\n`);
  if (Number.isFinite(q) && Number.isFinite(p) && q === 0 && p === 0) {
    console.log("search-docs index idle:", lastLine);
    process.exit(0);
  }
  sleep(POLL_MS);
}

console.error(`Timeout after ${MAX_WAIT_MS}ms; last: ${lastLine}`);
process.exit(1);
