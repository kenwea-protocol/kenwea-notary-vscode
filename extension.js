// Kenwea Notary for VS Code.
//
// In a package.json, each dependency is looked up in the npm registry (what it
// declares to run at install costs nothing to read), and only the few that run
// something are sent to the Kenwea notary, which runs those install steps in a
// no-network sandbox, traces them and signs what it saw. The record is verified
// here before anything is shown: signature, key, and that it is about the exact
// tarball npm installs. The result sits above the dependency as a CodeLens, in a
// hover, and in Problems when an install step reached for the network.
//
// It also offers the notary's MCP server to agents in VS Code (Copilot agent
// mode), where the editor supports MCP server definition providers.

"use strict";

const vscode = require("vscode");
const path = require("node:path");
const notary = require("./lib/notary");
const { dependencies, resolvedVersion } = require("./lib/deps");

const STORE_KEY = "kenwea.records.v1";
const MAX_PARALLEL_CHECKS = 2;

/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.Memento} */
let store;
/** @type {Map<string, any>} name@version -> entry */
const entries = new Map();
const lensChanged = new vscode.EventEmitter();
let running = 0;
/** @type {Array<() => void>} */
const queue = [];
let rateLimitedUntil = 0;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  output = vscode.window.createOutputChannel("Kenwea Notary");
  diagnostics = vscode.languages.createDiagnosticCollection("kenwea");
  store = context.globalState;
  for (const [k, v] of Object.entries(store.get(STORE_KEY, {}))) entries.set(k, v);

  const selector = { language: "json", pattern: "**/package.json" };
  context.subscriptions.push(
    output,
    diagnostics,
    vscode.languages.registerCodeLensProvider(selector, { onDidChangeCodeLenses: lensChanged.event, provideCodeLenses }),
    vscode.languages.registerHoverProvider(selector, { provideHover }),
    vscode.commands.registerCommand("kenwea.checkDependency", (name, version) => runCheck(name, version, true)),
    vscode.commands.registerCommand("kenwea.checkPackage", checkPackagePrompt),
    vscode.commands.registerCommand("kenwea.checkThisFile", () => {
      const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
      if (doc && path.basename(doc.fileName) === "package.json") scan(doc, true);
      else vscode.window.showInformationMessage("Kenwea: open a package.json first.");
    }),
    vscode.commands.registerCommand("kenwea.showOutput", () => output.show()),
    vscode.workspace.onDidOpenTextDocument((doc) => maybeScan(doc)),
    vscode.workspace.onDidSaveTextDocument((doc) => maybeScan(doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
  );
  for (const doc of vscode.workspace.textDocuments) maybeScan(doc);
  registerMcpServer(context);
}

/** @param {vscode.ExtensionContext} context */
function registerMcpServer(context) {
  const lm = /** @type {any} */ (vscode.lm);
  const Definition = /** @type {any} */ (vscode).McpHttpServerDefinition;
  if (!lm || typeof lm.registerMcpServerDefinitionProvider !== "function" || typeof Definition !== "function") return;
  context.subscriptions.push(
    lm.registerMcpServerDefinitionProvider("kenwea-notary", {
      provideMcpServerDefinitions: () => [new Definition("Kenwea Notary", vscode.Uri.parse(notary.NOTARY_URL))],
    }),
  );
}

/** @param {vscode.TextDocument} doc */
function maybeScan(doc) {
  if (path.basename(doc.fileName) !== "package.json" || doc.uri.scheme !== "file") return;
  if (doc.fileName.split(path.sep).includes("node_modules")) return;
  if (!config().get("lookUpOnOpen", true)) return;
  scan(doc, false);
}

function config() {
  return vscode.workspace.getConfiguration("kenwea");
}

/**
 * Read what each dependency declares to run at install, then send the ones that
 * run something to the notary (automatically only when kenwea.checkAutomatically
 * is on, or when the user asked for the whole file).
 * @param {vscode.TextDocument} doc
 * @param {boolean} userAsked
 */
async function scan(doc, userAsked) {
  const dir = path.dirname(doc.fileName);
  const deps = dependencies(doc.getText());
  const auto = userAsked || config().get("checkAutomatically", true);
  const limit = userAsked ? Infinity : config().get("maxAutomaticChecks", 5);
  let sent = 0;
  await Promise.all(
    deps.map(async (d) => {
      const r = resolvedVersion(dir, d.name, d.spec);
      if (!r) return;
      const key = `${d.name}@${r.version}`;
      let e = entries.get(key);
      if (!e) {
        const m = await notary.manifest(fetch, d.name, r.version);
        e = m.ok ? { state: "looked_up", manifest: m } : { state: "lookup_failed", error: m.error };
        if (!entries.get(key)) setEntry(key, e);
      }
      if (e.state === "looked_up" && e.manifest.declared.length && auto && sent < limit) {
        sent++;
        await runCheck(d.name, r.version, false);
      }
    }),
  );
  refreshDiagnostics(doc);
}

/**
 * @param {string} name
 * @param {string} version
 * @param {boolean} userAsked
 */
async function runCheck(name, version, userAsked) {
  const key = `${name}@${version}`;
  let e = entries.get(key);
  if (e && (e.state === "checking" || (e.state === "checked" && !userAsked))) return;
  if (Date.now() < rateLimitedUntil && !userAsked) return;
  if (!e || !e.manifest) {
    const m = await notary.manifest(fetch, name, version);
    if (!m.ok) {
      setEntry(key, { state: "lookup_failed", error: m.error });
      if (userAsked) vscode.window.showWarningMessage(`Kenwea: ${m.error}`);
      return;
    }
    e = { state: "looked_up", manifest: m };
  }
  const m = e.manifest;
  setEntry(key, { state: "checking", manifest: m });
  await slot();
  let res;
  try {
    log(`checking ${key} (${m.tarball})`);
    res = await notary.check(fetch, m);
  } finally {
    release();
  }
  if (res.ok) {
    const s = notary.summarize(res.facts);
    setEntry(key, {
      state: "checked",
      manifest: m,
      level: s.level,
      text: s.text,
      keyId: res.key.keyId,
      sha256: res.facts.contentSha256,
      issuedAt: res.facts.issuedAt,
      verdict: res.facts.verdict,
      reasonCode: res.facts.reasonCode,
      observed: res.facts.observed,
    });
    log(`${key}: ${s.text} (signed, verified under key ${res.key.keyId}, sha256 ${res.facts.contentSha256})`);
    if (s.level === "network") vscode.window.showWarningMessage(`Kenwea: ${key} ${s.text}.`, "Show details").then((a) => a && output.show());
    else if (userAsked) vscode.window.showInformationMessage(`Kenwea: ${key} ${s.text}.`);
  } else {
    if (res.kind === "refused" && /rate_limited/.test(res.error)) rateLimitedUntil = Date.now() + 10 * 60_000;
    setEntry(key, { state: res.kind === "unverified" ? "unverified" : "failed", manifest: m, error: res.error });
    log(`${key}: ${res.kind}: ${res.error}`);
    if (res.kind === "unverified") vscode.window.showWarningMessage(`Kenwea: the record for ${key} did not verify: ${res.error}`);
    else if (userAsked) vscode.window.showWarningMessage(`Kenwea: ${key} was not checked: ${res.error}`);
  }
  for (const doc of vscode.workspace.textDocuments) if (path.basename(doc.fileName) === "package.json") refreshDiagnostics(doc);
}

async function checkPackagePrompt() {
  const spec = await vscode.window.showInputBox({ prompt: "npm package to check, e.g. core-js@3.50.0 (no version means latest)", ignoreFocusOut: true });
  if (!spec) return;
  const s = spec.trim();
  const sep = s.indexOf("@", s.startsWith("@") ? 1 : 0);
  const name = sep === -1 ? s : s.slice(0, sep);
  const tag = sep === -1 ? "latest" : s.slice(sep + 1);
  const m = await notary.manifest(fetch, name, tag);
  if (!m.ok) return vscode.window.showWarningMessage(`Kenwea: ${m.error}`);
  const key = `${m.name}@${m.version}`;
  if (!entries.get(key)) setEntry(key, { state: "looked_up", manifest: m });
  if (!m.declared.length) {
    vscode.window.showInformationMessage(`Kenwea: ${key} declares nothing that runs at install (registry manifest), so there is nothing to run.`);
    return;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Kenwea: checking ${key}` }, () => runCheck(m.name, m.version, true));
}

/** @param {vscode.TextDocument} doc */
function provideCodeLenses(doc) {
  const dir = path.dirname(doc.fileName);
  const lenses = [];
  for (const d of dependencies(doc.getText())) {
    const r = resolvedVersion(dir, d.name, d.spec);
    const range = new vscode.Range(doc.positionAt(d.offset), doc.positionAt(d.offset + d.length));
    if (!r) continue;
    const key = `${d.name}@${r.version}`;
    const e = entries.get(key);
    const title = lensTitle(key, e);
    if (!title) continue;
    const runnable = e && e.manifest && e.manifest.declared.length && e.state !== "checking";
    lenses.push(new vscode.CodeLens(range, runnable ? { title, command: "kenwea.checkDependency", arguments: [d.name, r.version] } : { title, command: "kenwea.showOutput" }));
  }
  return lenses;
}

/** @param {string} key @param {any} e */
function lensTitle(key, e) {
  if (!e) return "";
  switch (e.state) {
    case "looked_up":
      return e.manifest.declared.length ? `$(warning) runs ${e.manifest.declared.join(", ")} at install: check it with Kenwea` : "";
    case "checking":
      return `$(sync~spin) Kenwea: running ${key}'s install steps in the sandbox`;
    case "checked":
      return `${e.level === "network" ? "$(error)" : e.level === "unfinished" ? "$(info)" : "$(verified)"} Kenwea: ${e.text}`;
    case "unverified":
      return `$(error) Kenwea: the record did not verify`;
    case "failed":
      return `$(circle-slash) Kenwea: not checked (${String(e.error).slice(0, 60)}), retry`;
    default:
      return "";
  }
}

/**
 * @param {vscode.TextDocument} doc
 * @param {vscode.Position} pos
 */
function provideHover(doc, pos) {
  const offset = doc.offsetAt(pos);
  const d = dependencies(doc.getText()).find((x) => offset >= x.offset && offset <= x.offset + x.length);
  if (!d) return null;
  const r = resolvedVersion(path.dirname(doc.fileName), d.name, d.spec);
  if (!r) return new vscode.Hover(`**Kenwea**: no installed or locked version of ${d.name} found, so nothing was looked up.`);
  const key = `${d.name}@${r.version}`;
  const e = entries.get(key);
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Kenwea notary**: \`${key}\` (version from ${r.from})\n\n`);
  if (!e || e.state === "lookup_failed") md.appendMarkdown(e ? `Registry lookup failed: ${e.error}` : "Not looked up yet.");
  else if (e.state === "looked_up") md.appendMarkdown(e.manifest.declared.length ? `Declares ${e.manifest.declared.join(", ")} at install. Not checked yet.` : "Declares nothing that runs at install (registry manifest). Nothing to run.");
  else if (e.state === "checking") md.appendMarkdown("Running its install steps in the sandbox now.");
  else if (e.state === "checked") {
    const o = e.observed || {};
    md.appendMarkdown(`${e.text}.\n\n`);
    md.appendMarkdown(`- verdict: \`${e.verdict}\` (\`${e.reasonCode}\`)\n- reached: ${[...(o.dns || []), ...(o.network || [])].join(", ") || "nothing"}\n- programs started: ${(o.programs || []).join(", ") || "none"}\n`);
    md.appendMarkdown(`- signed record verified here under key \`${e.keyId}\`, about sha256 \`${String(e.sha256).slice(0, 16)}…\` (the tarball npm installs)\n- issued ${e.issuedAt}\n\n`);
    md.appendMarkdown("Checked on its own, not inside your dependency tree; code your app calls later is not exercised. A quiet trace is evidence, not proof.");
  } else md.appendMarkdown(`${e.state === "unverified" ? "The record did not verify" : "Not checked"}: ${e.error}`);
  return new vscode.Hover(md);
}

/** @param {vscode.TextDocument} doc */
function refreshDiagnostics(doc) {
  const dir = path.dirname(doc.fileName);
  const list = [];
  for (const d of dependencies(doc.getText())) {
    const r = resolvedVersion(dir, d.name, d.spec);
    if (!r) continue;
    const e = entries.get(`${d.name}@${r.version}`);
    if (!e) continue;
    const range = new vscode.Range(doc.positionAt(d.offset), doc.positionAt(d.offset + d.length));
    let diag = null;
    if (e.state === "checked" && e.level === "network") diag = new vscode.Diagnostic(range, `${d.name}@${r.version} ${e.text}.`, vscode.DiagnosticSeverity.Warning);
    else if (e.state === "unverified") diag = new vscode.Diagnostic(range, `The Kenwea record for ${d.name}@${r.version} did not verify: ${e.error}`, vscode.DiagnosticSeverity.Warning);
    else if (e.state === "checked" && e.level !== "nothing") diag = new vscode.Diagnostic(range, `${d.name}@${r.version} ${e.text}.`, vscode.DiagnosticSeverity.Information);
    if (diag) {
      diag.source = "Kenwea";
      list.push(diag);
    }
  }
  diagnostics.set(doc.uri, list);
}

/** @param {string} key @param {any} e */
function setEntry(key, e) {
  entries.set(key, e);
  // Records are about immutable registry bytes, so a checked one is kept. Failures
  // and work in progress are not, so they are tried again next session.
  if (e.state === "checked" || e.state === "looked_up") {
    const saved = store.get(STORE_KEY, {});
    saved[key] = e;
    store.update(STORE_KEY, saved);
  }
  lensChanged.fire();
}

function slot() {
  if (running < MAX_PARALLEL_CHECKS) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(() => (running++, resolve())));
}

function release() {
  running--;
  const next = queue.shift();
  if (next) next();
}

/** @param {string} line */
function log(line) {
  output.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function deactivate() {}

module.exports = { activate, deactivate };
