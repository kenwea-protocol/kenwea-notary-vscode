"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { dependencies, resolvedVersion, isRegistrySpec } = require("../lib/deps");
const { summarize } = require("../lib/notary");

const pkg = `{
  "name": "app",
  "dependencies": {
    "express": "^4.18.2",
    "@scope/thing": "1.2.3",
    "local": "file:../local",
    "gitdep": "github:user/repo"
  },
  "devDependencies": {
    "core-js": "3.50.0"
  }
}`;

test("dependencies finds registry entries with their offsets", () => {
  const deps = dependencies(pkg);
  assert.deepStrictEqual(deps.map((d) => d.name), ["express", "@scope/thing", "core-js"]);
  for (const d of deps) assert.strictEqual(pkg.slice(d.offset, d.offset + d.length), JSON.stringify(d.name));
});

test("a name that also appears outside its section is found inside it", () => {
  const text = `{"name": "core-js", "devDependencies": {"core-js": "3.50.0"}}`;
  const [d] = dependencies(text);
  assert.ok(d.offset > text.indexOf("devDependencies"));
});

test("broken JSON gives nothing rather than throwing", () => {
  assert.deepStrictEqual(dependencies("{ not json"), []);
});

test("isRegistrySpec keeps versions and ranges, drops paths, git and aliases", () => {
  for (const s of ["^1.0.0", "1.2.3", "~2", "*", "latest", ">=1 <2"]) assert.ok(isRegistrySpec(s), s);
  for (const s of ["file:../x", "workspace:*", "github:a/b", "git+https://x/y.git", "npm:other@1", "https://x/y.tgz", "a/b"]) assert.ok(!isRegistrySpec(s), s);
});

test("resolvedVersion prefers node_modules, then the lockfile, then an exact spec", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kenwea-"));
  assert.strictEqual(resolvedVersion(dir, "express", "^4.18.2"), null);
  assert.deepStrictEqual(resolvedVersion(dir, "core-js", "3.50.0"), { version: "3.50.0", from: "package.json" });
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/express": { version: "4.21.2" } } }));
  assert.deepStrictEqual(resolvedVersion(dir, "express", "^4.18.2"), { version: "4.21.2", from: "package-lock.json" });
  fs.mkdirSync(path.join(dir, "node_modules", "express"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "express", "package.json"), JSON.stringify({ name: "express", version: "4.21.1" }));
  assert.deepStrictEqual(resolvedVersion(dir, "express", "^4.18.2"), { version: "4.21.1", from: "node_modules" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("summarize reads the signed facts", () => {
  assert.strictEqual(summarize({ installSteps: [] }).level, "nothing");
  assert.strictEqual(summarize({ installSteps: ["postinstall"], reasonCode: "ran_ok", observed: { dns: [], network: [] } }).level, "runs");
  const net = summarize({ installSteps: ["install"], reasonCode: "ran_tried_network", observed: { dns: ["scarf.sh"], network: [] } });
  assert.strictEqual(net.level, "network");
  assert.match(net.text, /scarf\.sh/);
  assert.strictEqual(summarize({ installSteps: ["postinstall"], reasonCode: "step_timed_out", observed: {} }).level, "unfinished");
  assert.strictEqual(summarize({ installSteps: ["postinstall"], reasonCode: "ran_ok", observed: { truncated: true } }).level, "unfinished");
});
