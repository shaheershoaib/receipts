import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The bundle-drift receipt.
 *
 * The plugin runs server.bundle.mjs, NOT index.js: Claude Code does not npm-install a
 * plugin's MCP server, so the SDK is inlined by esbuild and the bundle is what ships.
 * index.js grew a fifth tool (reopen_rate) and nobody rebuilt the bundle. Every unit test
 * imported the SOURCE, every CI job drove scripts directly, and the artifact users actually
 * load served four tools for two months while the README promised five - with CI green.
 *
 * This test speaks the real MCP handshake (initialize -> notifications/initialized ->
 * tools/list) to the BUNDLE over stdio, exactly as Claude Code does, and compares what it
 * serves against the tool names declared in index.js. The expected set is extracted from
 * the source, not written here, so the test keys off the one source of truth and goes red
 * the next time the bundle falls behind it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, "..", "server.bundle.mjs");
const SOURCE = path.join(HERE, "..", "index.js");
const TIMEOUT_MS = 10_000; // a hung server must FAIL the test, never hang the suite

// The ListTools handler is the declaration: `tools: [ { name: "...", ... }, ... ]`. Only
// tool entries carry a `name:` key inside that handler (property schemas use type /
// description / enum), so a line-anchored match over that block is exactly the tool list.
function declaredToolNames() {
  const src = fs.readFileSync(SOURCE, "utf8");
  const start = src.indexOf("ListToolsRequestSchema, async");
  const end = src.indexOf("CallToolRequestSchema, async", start);
  assert.ok(start >= 0 && end > start, "could not locate the ListTools handler in index.js");
  const block = src.slice(start, end);
  const names = [...block.matchAll(/^\s*name:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(names.length > 0, "extracted zero tool names from index.js - the regex no longer matches the source");
  return names.sort();
}

// Newline-delimited JSON-RPC over the child's stdio. Requests resolve by id; a timer turns a
// silent server into a failure with whatever it wrote to stderr attached.
function connect(child) {
  const pending = new Map();
  let buf = "";
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`no response to ${method} within ${TIMEOUT_MS}ms; server stderr: ${stderr || "(empty)"}`)),
          TIMEOUT_MS,
        );
        pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params = {}) { send({ jsonrpc: "2.0", method, params }); },
  };
}

test("the shipped bundle serves exactly the tools index.js declares (MCP handshake over stdio)", async () => {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "receipts-mcp-")), "trajectories.jsonl");
  const child = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, RECEIPTS_TRAJECTORY_STORE: store },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const rpc = connect(child);
    const init = await rpc.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "receipts-bundle-test", version: "0" },
    });
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
    assert.equal(init.result.serverInfo.name, "trajectory-kb");
    rpc.notify("notifications/initialized");

    const list = await rpc.request("tools/list");
    assert.ok(list.result, `tools/list failed: ${JSON.stringify(list.error)}`);
    const served = list.result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(
      served,
      declaredToolNames(),
      "server.bundle.mjs is out of date with index.js - run `npm run build` in plugin/mcp/trajectory-kb and commit the bundle",
    );
  } finally {
    child.kill();
  }
});
