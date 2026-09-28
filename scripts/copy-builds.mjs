// Kopiert die gebauten Extensions nach fertige-extension/, damit man sie ohne Node.js laden kann.
import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [from, to] of [
  ['.output/chrome-mv3', 'fertige-extension/chrome'],
  ['.output/firefox-mv3', 'fertige-extension/firefox'],
]) {
  await rm(resolve(root, to), { recursive: true, force: true });
  await cp(resolve(root, from), resolve(root, to), { recursive: true });
  console.log(`[copy] ${from} → ${to}`);
}
