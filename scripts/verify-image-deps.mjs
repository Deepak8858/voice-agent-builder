#!/usr/bin/env node
/**
 * Asserts that a built container image actually ships the dependency versions
 * pinned by `pnpm.overrides` in the root package.json.
 *
 * Why this exists
 * ---------------
 * The security patches for transitive advisories are expressed as
 * `pnpm.overrides`. npm does not read that field, so an image built with
 * `npm install` — or one that deletes pnpm-lock.yaml before installing —
 * resolves a *different*, unpatched graph than the one `pnpm audit` checks in
 * CI. That failure mode is silent: the audit gate stays green while production
 * ships vulnerable code.
 *
 * This script closes that gap by inspecting the real node_modules tree inside
 * the image, so the audited graph and the shipped graph are verified to agree.
 *
 * Usage (from CI, against a built image):
 *   docker run --rm -v "$PWD/scripts:/verify:ro" --entrypoint node \
 *     voiceforge-api:test /verify/verify-image-deps.mjs
 *
 * Exits non-zero and prints every violation if any package resolves below its
 * required minimum.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Minimum acceptable version per package, keyed by major where an advisory was
 * patched in more than one release line. These mirror the `pnpm.overrides`
 * block in the root package.json — update both together.
 */
const REQUIREMENTS = [
  { name: "postcss", major: 8, min: "8.5.18" },
  { name: "nanoid", major: 3, min: "3.3.17" },
  { name: "fast-uri", major: 3, min: "3.1.5" },
  { name: "fast-uri", major: 4, min: "4.1.2" },
  { name: "find-my-way", major: 9, min: "9.7.0" },
  { name: "brace-expansion", major: 5, min: "5.0.9" },
];

const TARGET_NAMES = new Set(REQUIREMENTS.map((r) => r.name));
const SEARCH_ROOTS = ["/app"];
const MAX_DEPTH = 12;

/** Compares two semver-ish version strings. Returns <0, 0 or >0. */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Collects every resolved version of the target packages inside the image. */
function collectInstalledVersions() {
  /** @type {Map<string, Set<string>>} name -> versions */
  const found = new Map();
  const seen = new Set();

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    // Guard against symlink cycles, which pnpm layouts can contain.
    if (seen.has(real)) return;
    seen.add(real);

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);

      if (TARGET_NAMES.has(entry.name)) {
        try {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(full, "package.json"), "utf8"),
          );
          if (manifest.name === entry.name && manifest.version) {
            if (!found.has(entry.name)) found.set(entry.name, new Set());
            found.get(entry.name).add(manifest.version);
          }
        } catch {
          // Not a package directory; keep walking.
        }
      }

      walk(full, depth + 1);
    }
  };

  for (const root of SEARCH_ROOTS) {
    if (fs.existsSync(root)) walk(root, 0);
  }
  return found;
}

const installed = collectInstalledVersions();
const violations = [];
const checked = [];

for (const { name, major, min } of REQUIREMENTS) {
  const versions = [...(installed.get(name) ?? [])].filter(
    (v) => Number.parseInt(v.split(".")[0], 10) === major,
  );

  // A package that is simply absent from this image is not a failure; not every
  // image contains every dependency (postcss is web-only, find-my-way is
  // fastify-only). We only assert on what is actually present.
  if (versions.length === 0) continue;

  for (const version of versions) {
    checked.push(`${name}@${version}`);
    if (compareVersions(version, min) < 0) {
      violations.push(
        `${name}@${version} is below the required ${min} (v${major} line)`,
      );
    }
  }
}

if (checked.length === 0) {
  console.error(
    "No target packages were found in the image. The search roots are probably " +
      "wrong, which would make this check silently vacuous.",
  );
  process.exit(1);
}

console.log(`Verified ${checked.length} resolved package(s):`);
for (const entry of checked.sort()) console.log(`  ${entry}`);

if (violations.length > 0) {
  console.error("\nVulnerable dependency versions found in the image:");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nThis usually means the image was built with npm, or the lockfile was " +
      "deleted before install, bypassing pnpm.overrides.",
  );
  process.exit(1);
}

console.log("\nAll pinned security overrides are present in the image.");
