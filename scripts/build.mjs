#!/usr/bin/env node
/**
 * Builds the distributable extension.
 *
 *   dist/                                  unpacked extension (load unpacked target)
 *   dist/<name>-<version>.zip              store / release upload
 *
 * The zip is written directly with zlib, so the build has no dependencies and
 * behaves the same on Linux, macOS and Windows. Archive timestamps are fixed,
 * so the same sources always produce the same archive.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

if (manifest.version !== pkg.version) {
  console.error(
    `✗ manifest.json version (${manifest.version}) does not match package.json (${pkg.version}).\n` +
      "  Run `npm run version:sync` first."
  );
  process.exit(1);
}

// Run the manifest / syntax checks before packaging anything.
const check = spawnSync(process.execPath, ["scripts/check.mjs"], { cwd: root, stdio: "inherit" });
if (check.status !== 0) process.exit(check.status ?? 1);

const payload = [
  "manifest.json",
  "src",
  "icons",
  "assets/icon.svg",
  "LICENSE"
];

function walk(entry, base = root) {
  const absolute = path.join(base, entry);
  const stats = statSync(absolute);
  if (stats.isDirectory()) {
    return readdirSync(absolute)
      .sort()
      .flatMap((child) => walk(path.join(entry, child), root));
  }
  return [entry];
}

const files = payload
  .filter((entry) => {
    const exists = statSync(path.join(root, entry), { throwIfNoEntry: false });
    if (!exists) console.warn(`! skipping missing ${entry}`);
    return Boolean(exists);
  })
  .flatMap((entry) => walk(entry))
  .sort();

// ---------------------------------------------------------------- zip writer

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = entry.data;
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

// ------------------------------------------------------------------- package

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const file of files) {
  const target = path.join(dist, file);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, file), target);
}

const zipName = `${pkg.name}-${pkg.version}.zip`;
const zip = createZip(
  files.map((file) => ({ name: file, data: readFileSync(path.join(root, file)) }))
);
writeFileSync(path.join(dist, zipName), zip);

const manifestInDist = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
if (manifestInDist.version !== pkg.version) {
  console.error("✗ dist/manifest.json version mismatch");
  process.exit(1);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
console.log(`✓ built ${files.length} files`);
console.log(`  dist/          ${files.map((f) => relPath(f)).join(", ")}`);
console.log(`  dist/${zipName}  ${kb(zip.length)}`);

function relPath(file) {
  return file.replace(/\\/g, "/");
}
