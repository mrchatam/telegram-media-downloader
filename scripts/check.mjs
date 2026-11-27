#!/usr/bin/env node
/**
 * Static sanity checks for the extension. No dependencies, no network.
 *
 * Verifies that the manifest is valid, that every file it references exists,
 * that the manifest version matches package.json and that every source file
 * parses. Pass --fix-version to copy the package.json version into the manifest.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixVersion = process.argv.includes("--fix-version");
const problems = [];

function rel(file) {
  return path.relative(root, file) || ".";
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${rel(file)}: invalid JSON (${error.message})`);
    return null;
  }
}

const pkg = readJson(path.join(root, "package.json"));
const manifestPath = path.join(root, "manifest.json");
const manifest = readJson(manifestPath);

if (pkg && manifest) {
  if (manifest.version !== pkg.version) {
    if (fixVersion) {
      manifest.version = pkg.version;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`Synced manifest.json version to ${pkg.version}`);
    } else {
      problems.push(
        `manifest.json version "${manifest.version}" does not match package.json version "${pkg.version}" ` +
          "(run `npm run version:sync`)"
      );
    }
  }
}

if (manifest) {
  if (manifest.manifest_version !== 3) {
    problems.push("manifest.json: manifest_version must be 3");
  }

  const referenced = new Set();
  const add = (value) => {
    if (typeof value === "string" && value && !/^https?:/i.test(value)) {
      referenced.add(value);
    }
  };

  Object.values(manifest.icons ?? {}).forEach(add);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  add(manifest.action?.default_popup);
  add(manifest.background?.service_worker);
  add(manifest.options_ui?.page);
  add(manifest.options_page);

  for (const script of manifest.content_scripts ?? []) {
    (script.js ?? []).forEach(add);
    (script.css ?? []).forEach(add);
  }

  if (referenced.size === 0) {
    problems.push("manifest.json: no extension files referenced");
  }

  for (const file of referenced) {
    if (!existsSync(path.join(root, file))) {
      problems.push(`manifest.json references missing file: ${file}`);
    }
  }

  const popup = manifest.action?.default_popup;
  if (popup) {
    const html = readFileSync(path.join(root, popup), "utf8");
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = match[1];
      if (/^(?:https?:|data:|#)/i.test(target)) continue;
      const resolved = path.join(path.dirname(path.join(root, popup)), target);
      if (!existsSync(resolved)) {
        problems.push(`manifest.json popup ${popup} references missing file: ${target}`);
      }
    }
  }

  if (!manifest.name || !manifest.description) {
    problems.push("manifest.json: name and description are required");
  }
  if (manifest.description && manifest.description.length > 132) {
    problems.push(
      `manifest.json: description is ${manifest.description.length} characters (Chrome allows 132)`
    );
  }
}

const sources = [
  "src/background.js",
  "src/content.js",
  "src/page-downloader.js",
  "src/popup.js"
].filter((file) => existsSync(path.join(root, file)));

for (const file of sources) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    problems.push(`${file}: syntax error\n${(result.stderr || "").trim()}`);
  }
}

if (problems.length > 0) {
  console.error("✗ check failed\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✓ check passed (${sources.length} source files, ${manifest ? "manifest valid" : ""})`);
