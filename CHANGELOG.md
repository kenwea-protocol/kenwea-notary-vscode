# Changelog

## 1.0.1

- A record with no install steps counts as "nothing runs at install" only when its reason code says so (no_install_steps). Records the check could not finish (extract_failed, no_manifest, report_unreliable, our limits) now show as not a pass.

## 1.0.0

- CodeLens, hover and Problems entries for dependencies that run something at install, from signed notary records verified locally.
- Registry lookup first, so only packages that declare install steps are sent to the notary.
- The Kenwea notary MCP server offered to agents in VS Code.
