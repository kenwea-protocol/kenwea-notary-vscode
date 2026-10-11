// Runs the extension inside a real VS Code against a fixture workspace and the
// live registry and notary. Needs @vscode/test-electron:
//   npm install --no-save @vscode/test-electron@2.5.2
//   VSCODE_PATH="<path to Code.exe>" node test-integration/run.js
// Without VSCODE_PATH, test-electron downloads a VS Code build.

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kenwea-ws-"));
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "fixture", private: true, dependencies: { "core-js": "3.50.0", "left-pad": "1.3.0" } }, null, 2),
  );
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_PATH || undefined,
      extensionDevelopmentPath: path.resolve(__dirname, ".."),
      extensionTestsPath: process.env.SUITE || path.resolve(__dirname, "suite.js"),
      launchArgs: [workspace, "--disable-extensions", "--user-data-dir", fs.mkdtempSync(path.join(os.tmpdir(), "kenwea-ud-"))],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
