#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const output = process.argv.find((argument) => argument.startsWith("--output="))?.slice(9) ?? "";
if (!output || !isAbsolute(output)) throw new Error("--output must be an explicit absolute path outside the repository");
const path = resolve(output);
const handle = await open(path, "wx", 0o600);
try { await handle.writeFile(`${randomBytes(48).toString("base64url")}\n`, "utf8"); }
finally { await handle.close(); }
console.log(`Created sealed corpus secret at ${path}; do not commit or print its contents.`);
