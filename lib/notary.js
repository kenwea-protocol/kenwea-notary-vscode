// The Kenwea notary, asked and checked from inside the editor.
//
// No dependency on the vscode module, so it runs under `node --test` too. The
// verification is the same as @kenwea/mcp 0.3.0's (packages/mcp-bridge/src/check.js):
// a verdict is shown only after
//   - the record's Ed25519 signature verifies here, under the key the payload names
//     in Kenwea's published key list, and that key is not revoked;
//   - the signed facts are about the tarball we asked about;
//   - the tarball npm would install has the registry's integrity hash and the
//     record's sha256.
// The signed facts are what is shown, never the unsigned copy beside them.

"use strict";

const { createHash, createPublicKey, verify: verifySignature } = require("node:crypto");

const NOTARY_URL = "https://mcp.kenwea.com/notary/v1";
const KEYS_URL = "https://www.kenwea.com/.well-known/kenwea-attestation-keys.json";
const REGISTRY = "https://registry.npmjs.org";
const PROTOCOL_VERSION = "2025-06-18";
const CHECK_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UNFINISHED = new Set(["step_timed_out", "run_incomplete", "trace_unavailable", "runner_busy", "not_run"]);

/**
 * The registry's manifest for one exact version, or the latest when no version is
 * given. It also says, without running anything, whether the package declares
 * anything that runs at install, which is what lets the editor ask the notary only
 * about the few packages that do.
 * @param {typeof fetch} doFetch
 * @param {string} name
 * @param {string} version an exact version or a dist-tag
 */
async function manifest(doFetch, name, version) {
  const url = `${REGISTRY}/${name}/${encodeURIComponent(version || "latest")}`;
  try {
    const res = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `the registry returned HTTP ${res.status} for ${name}@${version}` };
    const body = JSON.parse(await res.text());
    const tarball = body && body.dist && body.dist.tarball;
    if (typeof tarball !== "string" || !/^https:\/\//i.test(tarball)) return { ok: false, error: `no tarball for ${name}@${version}` };
    const scripts = body.scripts && typeof body.scripts === "object" ? body.scripts : {};
    const declared = ["preinstall", "install", "postinstall"].filter((s) => typeof scripts[s] === "string");
    // npm adds `node-gyp rebuild` as the install step of a package that ships a
    // binding.gyp and declares no install script; the manifest says so with gypfile.
    if (body.gypfile === true && !declared.includes("install") && !declared.includes("preinstall")) declared.push("install (node-gyp)");
    return {
      ok: true,
      name: String(body.name),
      version: String(body.version),
      tarball,
      integrity: typeof body.dist.integrity === "string" ? body.dist.integrity : "",
      shasum: typeof body.dist.shasum === "string" ? body.dist.shasum : "",
      declared,
    };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Ask the notary about one tarball and verify what comes back.
 * @param {typeof fetch} doFetch
 * @param {{name: string, version: string, tarball: string, integrity: string, shasum: string}} pkg
 * @param {{notaryUrl?: string, keysUrl?: string}} [opts]
 * @returns {Promise<{ok: true, facts: any, result: any, key: {keyId: string, status: string}} | {ok: false, kind: "refused"|"no_answer"|"unverified", error: string, result?: any}>}
 */
async function check(doFetch, pkg, opts = {}) {
  let res;
  try {
    res = await doFetch(opts.notaryUrl || NOTARY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kenwea.notary.check", arguments: { artifactRef: pkg.tarball } } }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, kind: "no_answer", error: `the notary could not be reached: ${message(e)}` };
  }
  let body = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.error) {
    const e = body && body.error;
    return { ok: false, kind: "no_answer", error: e ? `${e.message || "error"} (HTTP ${res.status})` : `HTTP ${res.status}` };
  }
  const result = toolResult(body);
  if (body.result && body.result.isError) {
    const r = result || {};
    return { ok: false, kind: "refused", error: `${r.error || "refused"}${r.detail ? `: ${r.detail}` : ""}` };
  }
  if (!result || typeof result !== "object") return { ok: false, kind: "no_answer", error: "the notary returned no readable result" };
  if (result.checked === false) return { ok: false, kind: "no_answer", error: `not checked: ${result.reason || "no reason given"}`, result };

  const verified = await verifyRecord(doFetch, result, pkg.tarball, opts.keysUrl || KEYS_URL);
  if (!verified.ok) return { ok: false, kind: "unverified", error: verified.error, result };
  const match = await matchTarball(doFetch, pkg, String(verified.facts.contentSha256 || ""));
  if (!match.ok) return { ok: false, kind: "unverified", error: `the record is not about the bytes npm installs: ${match.error}`, result };
  return { ok: true, facts: verified.facts, result, key: verified.key };
}

/**
 * @param {typeof fetch} doFetch
 * @param {any} result
 * @param {string} ref
 * @param {string} keysUrl
 */
async function verifyRecord(doFetch, result, ref, keysUrl) {
  const signed = result && result.signedAttestation;
  if (!signed || typeof signed.payload !== "string" || typeof signed.signature !== "string") return { ok: false, error: "the record carries no signature" };
  let facts;
  try {
    facts = JSON.parse(signed.payload);
  } catch {
    return { ok: false, error: "the signed payload is not JSON" };
  }
  if (!facts || facts.issuer !== "kenwea.com") return { ok: false, error: "the signed payload does not name kenwea.com as its issuer" };
  const listed = await fetchKeys(doFetch, keysUrl);
  if (!listed.ok) return { ok: false, error: `could not read the published keys: ${listed.error}` };
  const named = typeof facts.keyId === "string" ? facts.keyId : "";
  const candidates = named ? listed.keys.filter((k) => k.keyId === named) : listed.keys;
  if (named && !candidates.length) return { ok: false, error: `the record names key ${named}, which is not published` };
  const sig = Buffer.from(signed.signature, "base64");
  const signer = candidates.find((k) => {
    try {
      const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(k.publicKeyBase64, "base64")]), format: "der", type: "spki" });
      return verifySignature(null, Buffer.from(signed.payload, "utf8"), key, sig);
    } catch {
      return false;
    }
  });
  if (!signer) return { ok: false, error: "the signature does not match the payload under any published key" };
  if (signer.status === "revoked") return { ok: false, error: `it was signed with key ${signer.keyId}, which Kenwea has revoked` };
  if (facts.artifactRef !== ref) return { ok: false, error: `the signed record is about ${facts.artifactRef}, not ${ref}` };
  if (result.contentSha256 !== undefined && result.contentSha256 !== facts.contentSha256) return { ok: false, error: "the unsigned sha256 differs from the signed one" };
  if (result.verdict !== undefined && result.verdict !== facts.verdict) return { ok: false, error: "the unsigned verdict differs from the signed one" };
  return { ok: true, facts, key: { keyId: signer.keyId, status: signer.status } };
}

/** @type {Map<string, {at: number, value: any}>} */
const keyCache = new Map();

/**
 * Published keys, each kept only if its keyId is the one derived from the key.
 * Held for an hour.
 * @param {typeof fetch} doFetch
 * @param {string} keysUrl
 */
async function fetchKeys(doFetch, keysUrl) {
  const hit = keyCache.get(keysUrl);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
  try {
    const res = await doFetch(keysUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const doc = JSON.parse(await res.text());
    const keys = (Array.isArray(doc && doc.keys) ? doc.keys : []).filter(
      (k) =>
        k &&
        k.algorithm === "ed25519" &&
        typeof k.publicKeyBase64 === "string" &&
        Buffer.from(k.publicKeyBase64, "base64").length === 32 &&
        createHash("sha256").update(k.publicKeyBase64).digest("hex").slice(0, 16) === k.keyId,
    );
    if (!keys.length) return { ok: false, error: "the list holds no usable key" };
    const value = { ok: true, keys };
    keyCache.set(keysUrl, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * @param {typeof fetch} doFetch
 * @param {{tarball: string, integrity: string, shasum: string}} pkg
 * @param {string} recordSha256
 */
async function matchTarball(doFetch, pkg, recordSha256) {
  let bytes;
  try {
    const res = await doFetch(pkg.tarball, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2) });
    if (!res.ok) return { ok: false, error: `the tarball returned HTTP ${res.status}` };
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `could not download the tarball: ${message(e)}` };
  }
  if (bytes.length > MAX_TARBALL_BYTES) return { ok: false, error: "the tarball is larger than the notary reads" };
  const sriOk = pkg.integrity
    ? pkg.integrity
        .split(/\s+/)
        .filter((s) => s.startsWith("sha512-"))
        .some((s) => s.slice(7) === createHash("sha512").update(bytes).digest("base64"))
    : !!pkg.shasum && pkg.shasum === createHash("sha1").update(bytes).digest("hex");
  if (!sriOk) return { ok: false, error: "the tarball does not match the registry's integrity hash" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== recordSha256.toLowerCase()) return { ok: false, error: `the tarball has sha256 ${sha256}, the record ${recordSha256 || "none"}` };
  return { ok: true };
}

/**
 * What the signed facts say, in a few words, and how loud the editor should be.
 * level: "network" (an install step reached for the network), "unfinished" (a
 * step failed or was not watched to the end), "runs" (something runs and reached
 * nothing), "nothing" (nothing of the package's own runs at install).
 * @param {any} facts
 */
function summarize(facts) {
  const steps = Array.isArray(facts.installSteps) ? facts.installSteps : [];
  if (!steps.length) return { level: "nothing", text: "nothing runs at install" };
  const observed = facts.observed && typeof facts.observed === "object" ? facts.observed : {};
  const reached = [...(Array.isArray(observed.dns) ? observed.dns : []), ...(Array.isArray(observed.network) ? observed.network : [])];
  const runs = `runs ${steps.join(", ")} at install`;
  if (reached.length) return { level: "network", text: `${runs}; it tried to reach ${reached.slice(0, 3).join(", ")}${reached.length > 3 ? ` and ${reached.length - 3} more` : ""}` };
  if (UNFINISHED.has(facts.reasonCode) || observed.truncated) return { level: "unfinished", text: `${runs}; the check did not see it finish (${facts.reasonCode}), so this is not a pass` };
  if (facts.reasonCode && facts.reasonCode !== "ran_ok") return { level: "unfinished", text: `${runs}; ${facts.reasonCode}` };
  return { level: "runs", text: `${runs}; it finished and reached for nothing` };
}

/** @param {any} body */
function toolResult(body) {
  const r = body && body.result;
  if (!r) return null;
  const text = Array.isArray(r.content) && r.content[0] && typeof r.content[0].text === "string" ? r.content[0].text : null;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return r.structuredContent && typeof r.structuredContent === "object" ? r.structuredContent : null;
}

/** @param {unknown} e */
function message(e) {
  return String((e && /** @type {any} */ (e).message) || e);
}

module.exports = { NOTARY_URL, KEYS_URL, manifest, check, verifyRecord, summarize };
