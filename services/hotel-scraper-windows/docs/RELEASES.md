# Desktop releases

The existing autonomous-business package is the initial numbered release, v1.0.0.
It was relocated without modifying its executable. Its embedded UI/file metadata
predates version numbering; the release folder identifies its version.

Double-click `Start Latest.bat` in the project root to launch the version in
`VERSION`. The launcher refuses to start a second scraper while one is running.
Stop the current scraper gracefully before switching releases.

For future builds, increment `VERSION` using major.minor.patch (for example,
1.0.1 for a fix, 1.1.0 for a feature, 2.0.0 for a breaking change), then run
`build_exe.ps1`. Packages go to `releases/v<version>/HusshOne-Hotel-Scraper/`.
Existing numbered releases are never overwritten by the build script.

Old unnumbered packages are recoverably archived under
`cleanup-backups/exe-releases-2026-10-07/`. The running `dist-fleet-audit`
package was deliberately left in place. Do not move or delete it until its
process and child workers have stopped. Runtime databases, logs, Chrome
profiles and production Cloud SQL data are not part of this cleanup.
