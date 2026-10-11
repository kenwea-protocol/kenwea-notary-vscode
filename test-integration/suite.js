"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vscode = require("vscode");

/** @param {() => Promise<boolean>} cond @param {number} ms */
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function run() {
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const doc = await vscode.workspace.openTextDocument(path.join(folder, "package.json"));
  await vscode.window.showTextDocument(doc);

  const titles = async () => {
    const lenses = (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", doc.uri)) || [];
    return lenses.map((l) => (l.command ? l.command.title : ""));
  };

  const settled = await until(async () => (await titles()).some((t) => t.includes("reached for nothing")), 150_000);
  const seen = await titles();
  console.log("CodeLens titles:", JSON.stringify(seen));
  assert.ok(settled, `core-js was not checked and verified; lenses: ${JSON.stringify(seen)}`);
  assert.strictEqual(seen.length, 1, "left-pad runs nothing at install, so it gets no lens");
  assert.match(seen[0], /runs postinstall at install; it finished and reached for nothing/);

  const diags = vscode.languages.getDiagnostics(doc.uri);
  console.log("Diagnostics:", JSON.stringify(diags.map((d) => [d.severity, d.message])));
  assert.strictEqual(diags.length, 1);
  assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Information);

  const pos = doc.positionAt(doc.getText().indexOf('"core-js"') + 2);
  const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, pos);
  const hoverText = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
  console.log("Hover:", hoverText.replace(/\n+/g, " | "));
  assert.match(hoverText, /verified here under key `[0-9a-f]{16}`/);

}

module.exports = { run };
