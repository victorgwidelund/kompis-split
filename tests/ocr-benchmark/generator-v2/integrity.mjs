import { createHash, createHmac } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const CORPUS_FORMAT = "kompis-receipt-corpus/v2";
export const COMMITMENT_FORMAT = "kompis-receipt-corpus-commitment/v1";
export const MARKER_FILE = ".kompis-receipt-corpus-v2.json";

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveFixtureSeed(secret, fixtureId) {
  return createHmac("sha256", secret).update(`kompis-receipt-v2:${fixtureId}`, "utf8").digest();
}

function normalizedPath(path) {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLocaleLowerCase("en-US") : full;
}

export function isPathInside(candidate, parent) {
  const child = normalizedPath(candidate);
  const root = normalizedPath(parent);
  return child === root || child.startsWith(`${root}${sep}`);
}

export function assertSafeOutputPath(outputPath, { repoRoot, kind }) {
  if (!outputPath || !isAbsolute(outputPath)) throw new Error("Corpus output must be an explicit absolute path");
  const output = resolve(outputPath);
  const protectedPaths = [resolve(repoRoot), resolve(repoRoot, "tests"), resolve(repoRoot, "tests", "ocr-benchmark"), resolve(repoRoot, "tests", "ocr-benchmark", "corpus")];
  if (protectedPaths.some((entry) => normalizedPath(entry) === normalizedPath(output))) {
    throw new Error(`Refusing to use shared project directory as corpus output: ${output}`);
  }
  if (kind === "sealed-final" && isPathInside(output, repoRoot)) {
    throw new Error("The sealed final corpus must live outside the Git repository");
  }
  const root = resolve(output).split(sep).filter(Boolean);
  if (root.length < 2) throw new Error(`Refusing dangerously broad corpus output: ${output}`);
  return output;
}

async function listTree(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  const directories = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const full = resolve(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Corpus output contains a symlink and cannot be replaced safely: ${full}`);
    if (entry.isDirectory()) {
      const nested = await listTree(root, full);
      files.push(...nested.files);
      directories.push(...nested.directories, full);
    } else if (entry.isFile()) files.push(full);
    else throw new Error(`Corpus output contains an unsupported filesystem entry: ${full}`);
  }
  return { files, directories };
}

async function removeMarkedCorpus(output, marker) {
  const { files, directories } = await listTree(output);
  const actual = files.map((file) => relative(output, file).replaceAll("\\", "/")).sort();
  const expected = [...marker.expectedFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Refusing to replace corpus output because its contents no longer match its safety marker");
  }
  for (const file of files) await unlink(file);
  for (const directory of directories.sort((a, b) => b.length - a.length)) await rmdir(directory);
  await rmdir(output);
}

export async function prepareOutputDirectory(outputPath, { repoRoot, kind, replace = false, expectedFiles }) {
  const output = assertSafeOutputPath(outputPath, { repoRoot, kind });
  let exists = false;
  try { await lstat(output); exists = true; } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (exists) {
    if (!replace) throw new Error(`Corpus output already exists: ${output}`);
    let marker;
    try { marker = JSON.parse(await readFile(resolve(output, MARKER_FILE), "utf8")); }
    catch { throw new Error("Refusing to replace output without a valid schema-v2 safety marker"); }
    if (marker.format !== CORPUS_FORMAT || marker.outputBasename !== basename(output) || !Array.isArray(marker.expectedFiles)) {
      throw new Error("Refusing to replace output with an invalid schema-v2 safety marker");
    }
    await removeMarkedCorpus(output, marker);
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const marker = { format: CORPUS_FORMAT, complete: false, outputBasename: basename(output), expectedFiles: [...expectedFiles].sort() };
  await writeFile(resolve(output, MARKER_FILE), canonicalJson(marker), { flag: "wx" });
  return { output, marker };
}

export async function markOutputComplete(output, marker, commitmentSha256) {
  await writeFile(resolve(output, MARKER_FILE), canonicalJson({ ...marker, complete: true, commitmentSha256 }));
}

export async function hashFile(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

export async function verifyBundle(bundlePath, { repoRoot, requireExternal = true } = {}) {
  const bundle = resolve(bundlePath);
  if (requireExternal && repoRoot && isPathInside(bundle, repoRoot)) throw new Error("Sealed bundle must be outside the Git repository");
  const marker = JSON.parse(await readFile(resolve(bundle, MARKER_FILE), "utf8"));
  if (marker.format !== CORPUS_FORMAT || marker.complete !== true) throw new Error("Corpus bundle is incomplete or has an invalid marker");
  const manifestText = await readFile(resolve(bundle, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const commitment = JSON.parse(await readFile(resolve(bundle, "commitment.json"), "utf8"));
  if (manifest.format !== CORPUS_FORMAT || commitment.format !== COMMITMENT_FORMAT) throw new Error("Unsupported corpus bundle format");
  const manifestHash = sha256(Buffer.from(canonicalJson(manifest)));
  if (commitment.manifestSha256 !== manifestHash) throw new Error("Corpus manifest commitment does not match");
  for (const entry of [...manifest.files].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    const filePath = resolve(bundle, ...entry.path.split("/"));
    if (!isPathInside(filePath, bundle)) throw new Error(`Unsafe file path in corpus manifest: ${entry.path}`);
    const actual = await hashFile(filePath);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) throw new Error(`Corpus file integrity check failed: ${entry.path}`);
  }
  return { bundle, manifest, commitment, marker };
}

export async function withExclusiveLock(lockPath, callback) {
  const handle = await open(lockPath, "wx");
  try { return await callback(); }
  finally { await handle.close(); await unlink(lockPath).catch(() => {}); }
}

export async function atomicWrite(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { flag: "wx" });
  await rename(temporary, path);
}

export async function resolveExistingRealPath(path) {
  return realpath(resolve(path));
}
