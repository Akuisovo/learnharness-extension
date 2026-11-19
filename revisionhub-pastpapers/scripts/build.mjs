/**
 * Minimal build: copy source files into dist/ with the runtime layout required
 * by LearnHarness. No bundling is needed; the plugin uses only public plugin
 * APIs and plain JS/CJS with Node built-ins.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const files = ["manifest.json", "main.js", "backend.cjs", "revisionhub.cjs", "browsercookie.cjs", "styles.css"];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(path.join(src, file), path.join(dist, file));
console.log(`Built ${files.length} files into ${dist}`);
