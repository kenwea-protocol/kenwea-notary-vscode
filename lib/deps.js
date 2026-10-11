// Where a package.json names its dependencies, and which exact version of each
// npm will install. No vscode dependency, so it is tested under `node --test`.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const EXACT = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;

/**
 * Every registry dependency in a package.json, with the offset of its name in the
 * text. Specs that are not registry versions (file:, git, URLs, workspace:,
 * aliases) are left out: the notary checks registry tarballs.
 * @param {string} text
 * @returns {Array<{name: string, spec: string, section: string, offset: number, length: number}>}
 */
function dependencies(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  for (const section of SECTIONS) {
    const deps = doc && doc[section];
    if (!deps || typeof deps !== "object") continue;
    const open = new RegExp(`"${section}"\\s*:\\s*\\{`).exec(text);
    if (!open) continue;
    const start = open.index + open[0].length;
    const end = text.indexOf("}", start);
    const block = text.slice(start, end === -1 ? text.length : end);
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !NAME.test(name) || !isRegistrySpec(spec)) continue;
      const at = block.indexOf(JSON.stringify(name));
      if (at === -1) continue;
      out.push({ name, spec, section, offset: start + at, length: JSON.stringify(name).length });
    }
  }
  return out;
}

/** @param {string} spec */
function isRegistrySpec(spec) {
  const s = spec.trim();
  if (!s || s === "*" || s === "latest") return true;
  if (/^(file|link|workspace|git|git\+\w+|github|npm|portal|patch):/i.test(s)) return false;
  if (/^(https?:)?\/\//i.test(s) || s.includes("/")) return false;
  return true;
}

/**
 * The version npm has installed or will install for a dependency: what is in
 * node_modules, then what the lockfile pins, then the spec itself when it is an
 * exact version. Null when none of those says.
 * @param {string} dir the folder that holds the package.json
 * @param {string} name
 * @param {string} spec
 * @returns {{version: string, from: "node_modules"|"package-lock.json"|"package.json"} | null}
 */
function resolvedVersion(dir, name, spec) {
  const installed = readJson(path.join(dir, "node_modules", ...name.split("/"), "package.json"));
  if (installed && typeof installed.version === "string" && installed.name === name) return { version: installed.version, from: "node_modules" };
  const lock = readJson(path.join(dir, "package-lock.json"));
  if (lock) {
    const v2 = lock.packages && lock.packages[`node_modules/${name}`];
    if (v2 && typeof v2.version === "string" && EXACT.test(v2.version)) return { version: v2.version, from: "package-lock.json" };
    const v1 = lock.dependencies && lock.dependencies[name];
    if (v1 && typeof v1.version === "string" && EXACT.test(v1.version)) return { version: v1.version, from: "package-lock.json" };
  }
  const exact = spec.trim().replace(/^=/, "");
  if (EXACT.test(exact)) return { version: exact, from: "package.json" };
  return null;
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

module.exports = { dependencies, resolvedVersion, isRegistrySpec };
