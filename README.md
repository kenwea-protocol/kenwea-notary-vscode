# Kenwea Notary for VS Code

See, above each dependency in your `package.json`, what it runs when it is installed and whether that tried to reach the network. The answer comes from a signed record that is verified on your machine.

```
"core-js": "^3.50.0",
 ✓ Kenwea: runs postinstall at install; it finished and reached for nothing
```

## How it works

1. When a `package.json` opens, the extension reads from the npm registry what each dependency declares to run at install (`preinstall`, `install`, `postinstall`, or a `binding.gyp` that makes npm run node-gyp). Most packages declare nothing, and nothing more happens for them. The version used is the one in `node_modules`, then the one `package-lock.json` pins, then an exact version in `package.json`.
2. The few that do run something are sent to the [Kenwea notary](https://www.kenwea.com/verify). It downloads the exact tarball npm would install and runs those install steps in a container with no network, no capabilities, a read-only filesystem and no root, tracing the network connections, DNS lookups and programs each step attempts.
3. The record comes back signed with Ed25519. Before anything is shown, the extension checks the signature against Kenwea's [published key list](https://www.kenwea.com/.well-known/kenwea-attestation-keys.json), refuses a revoked key, and downloads the tarball itself to confirm it matches both the registry's integrity hash and the record's sha256.

| The record says | You see |
| --- | --- |
| an install step tried to reach the network | a warning in Problems and a notification, with what it reached |
| the record did not verify | a warning |
| a step failed or was not watched to the end | an information entry; that is not a pass |
| it runs something and reached for nothing | an information entry and a CodeLens |
| nothing of the package's own runs at install | nothing |

Hover a dependency name for the details: verdict, what was reached, programs started, the key and the sha256 the record is about.

## For agents

The extension also offers the notary as an MCP server (`kenwea.notary.check`, `kenwea.notary.verify`, `kenwea.notary.getPublicKey`) to agents in VS Code, such as Copilot agent mode, so an agent can check a package before it installs it.

## Commands

- **Kenwea: Check an npm package**: check any package by name, with or without a version.
- **Kenwea: Check every dependency in this package.json that runs something at install**: no automatic limit.
- **Kenwea: Show the notary log**

## Settings

- `kenwea.lookUpOnOpen` (default on): read install declarations from the npm registry when a package.json opens.
- `kenwea.checkAutomatically` (default on): send the dependencies that run something at install to the notary without asking.
- `kenwea.maxAutomaticChecks` (default 5): at most this many automatic checks per open or save.

No account and no key. The notary allows 20 checks per hour per network address. Each record is kept by the extension, so a package version is checked once.

## What a check does not tell you

- A package is checked on its own, not inside your dependency tree. Some behave differently as a dependency: @scarf/scarf sends install telemetry only then ([measured](https://www.kenwea.com/guides/npm-top-5000-install-steps-traced)).
- Code that only runs when your app calls it is not exercised.
- A script written to notice it is being watched can stay quiet. A quiet trace is evidence, not proof.

## Privacy

Registry lookups go to registry.npmjs.org, as `npm install` does. Only for packages that run something at install, the tarball address (which names the package and version) is sent to Kenwea's notary. Nothing else from your project leaves your machine. See the [privacy policy](https://www.kenwea.com/privacy).

MIT licensed. Part of [Kenwea](https://www.kenwea.com).
