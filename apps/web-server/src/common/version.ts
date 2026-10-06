/**
 * Single source of truth for the web-server version string.
 *
 * The value is mirrored from `apps/web-server/package.json#version` — that file
 * is what the release tooling bumps (`scripts/bump-version.mjs`), and
 * `tests/version-sot.test.ts` fails the build if the two ever disagree.
 *
 * Why a mirrored constant rather than importing package.json at runtime: this
 * module is bundled into the embed bridge and consumed by the desktop shell,
 * and pulling a JSON file into those bundles makes the artifact depend on
 * where it was built from. A string constant keeps the bundle self-contained;
 * the test is what keeps it honest.
 *
 * Format is CalVer (YYYY.MM.DD[.N]) — see the root `VERSION` file. It used to
 * be strict semver; it is no longer, and the tag scheme drifted so far from the
 * hardcoded literal (`v0.8.1360` vs `'0.8.0'`) that the constant had stopped
 * meaning anything at all.
 */
export const WEB_SERVER_VERSION = '2026.10.06'
