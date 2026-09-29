// Copies the built extensions to prebuilt/ so they can be loaded without Node.js.
import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [from, to] of [
  ['.output/chrome-mv3', 'prebuilt/chrome'],
  ['.output/firefox-mv3', 'prebuilt/firefox'],
]) {
  await rm(resolve(root, to), { recursive: true, force: true });
  await cp(resolve(root, from), resolve(root, to), { recursive: true });
  console.log(`[copy] ${from} → ${to}`);
}
