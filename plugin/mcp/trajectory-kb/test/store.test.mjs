import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStore, HOME_STORE } from "../store.mjs";

/* Store resolution: home (private) vs repo (team-shared, committed) vs explicit path. */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "receipts-store-"));
const writeCfg = (dir, cfg) => fs.writeFileSync(path.join(dir, "receipts.config.json"), JSON.stringify(cfg));

test("no config anywhere -> home store (zero-config default)", () => {
  assert.equal(resolveStore(tmp(), {}), HOME_STORE);
});

test("agent.trajectory_store: 'repo' -> .receipts/ NEXT TO THE CONFIG (team-shared)", () => {
  const d = tmp();
  writeCfg(d, { version: 1, agent: { trajectory_store: "repo" } });
  assert.equal(resolveStore(d, {}), path.join(d, ".receipts", "trajectories.jsonl"));
});

test("the config is found by walking UP from a nested cwd", () => {
  const d = tmp();
  writeCfg(d, { version: 1, agent: { trajectory_store: "repo" } });
  const nested = path.join(d, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveStore(nested, {}), path.join(d, ".receipts", "trajectories.jsonl"));
});

test("'home' (or no agent block) -> home store", () => {
  const a = tmp();
  writeCfg(a, { version: 1, agent: { trajectory_store: "home" } });
  assert.equal(resolveStore(a, {}), HOME_STORE);
  const b = tmp();
  writeCfg(b, { version: 1 });
  assert.equal(resolveStore(b, {}), HOME_STORE);
});

test("an explicit path resolves against the config's directory", () => {
  const d = tmp();
  writeCfg(d, { version: 1, agent: { trajectory_store: "memory/team.jsonl" } });
  assert.equal(resolveStore(d, {}), path.join(d, "memory", "team.jsonl"));
});

test("RECEIPTS_TRAJECTORY_STORE env overrides everything", () => {
  const d = tmp();
  writeCfg(d, { version: 1, agent: { trajectory_store: "repo" } });
  const override = path.join(d, "elsewhere.jsonl");
  assert.equal(resolveStore(d, { RECEIPTS_TRAJECTORY_STORE: override }), override);
});

test("an unreadable config fails SAFE to the home store", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "receipts.config.json"), "{not json");
  assert.equal(resolveStore(d, {}), HOME_STORE);
});
