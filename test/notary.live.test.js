"use strict";

// Against the real registry and notary. Skipped unless KENWEA_LIVE=1, since it
// spends notary quota.

const test = require("node:test");
const assert = require("node:assert");
const notary = require("../lib/notary");

const live = process.env.KENWEA_LIVE === "1";

test("core-js@3.50.0: postinstall declared, checked, verified", { skip: !live }, async () => {
  const m = await notary.manifest(fetch, "core-js", "3.50.0");
  assert.ok(m.ok, m.error);
  assert.deepStrictEqual(m.declared, ["postinstall"]);
  const r = await notary.check(fetch, m);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.facts.artifactRef, m.tarball);
  assert.strictEqual(notary.summarize(r.facts).level, "runs");
});

test("left-pad@1.3.0 declares nothing at install", { skip: !live }, async () => {
  const m = await notary.manifest(fetch, "left-pad", "1.3.0");
  assert.ok(m.ok, m.error);
  assert.deepStrictEqual(m.declared, []);
});

test("a tampered record does not verify", { skip: !live }, async () => {
  const m = await notary.manifest(fetch, "core-js", "3.50.0");
  const r = await notary.check(fetch, m);
  assert.ok(r.ok, r.error);
  const bad = JSON.parse(JSON.stringify(r.result));
  bad.signedAttestation.payload = bad.signedAttestation.payload.replace('"approved"', '"approved" ');
  const v = await notary.verifyRecord(fetch, bad, m.tarball, notary.KEYS_URL);
  assert.strictEqual(v.ok, false);
});
