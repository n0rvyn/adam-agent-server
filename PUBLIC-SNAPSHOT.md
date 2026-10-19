# Historical source snapshot

This repository contains the historical Adam main-line source, released under the accompanying MIT license. It is no longer actively maintained. The package.json version is 1.19.1, but this snapshot also contains later main-line work; use npm for the original published package.

Included: backend, Web UI, unit tests and synthetic fixtures, build configuration, dependency lockfiles, audit utilities, and API/authentication documentation. The retained CLI/TUI source is historical, with no new functionality added.

Excluded: original Git history and release automation, personal configuration and planning records, production/live-server end-to-end tests, browser end-to-end tests, one-off operator scripts, bundled browser extension, runtime databases/logs, credentials, dependency trees, generated builds, private postmortems, and the unmerged SDK-native experiment.

No new build or tests were run during archival preparation. Review dependency security and compatibility before running. Unit tests use mock/in-memory infrastructure; excluded end-to-end tests could operate a live server. This snapshot does not claim current production readiness.

Third-party packages are installed from package manifests and remain subject to their own licenses. They are not relicensed by this project's MIT license. No historical node_modules binaries are distributed here.
