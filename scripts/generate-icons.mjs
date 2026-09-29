// Generates all manifest icon sizes (public/icon/<size>.png) and a larger variant for the UI
// (public/logo-ui.png) from f12collector-logo.png. The source logo is only read, never modified.
//
// The logo has a lot of black padding, so it is trimmed to its content first, placed on a square
// black tile with a small margin and given rounded corners – this keeps it legible at 16 px.
import sharp from 'sharp';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'f12collector-logo.png');
const script = fileURLToPath(import.meta.url);
const outputs = [
  ...[16, 32, 48, 128].map((size) => ({ size, file: `public/icon/${size}.png` })),
  { size: 256, file: 'public/logo-ui.png' },
];

/** Logo trimmed to its content, centered on a square black tile. */
async function squareTile() {
  const trimmed = await sharp(source).trim({ threshold: 30 }).toBuffer({ resolveWithObject: true });
  const { width, height } = trimmed.info;
  const side = Math.round(Math.max(width, height) * 1.2);
  const left = Math.floor((side - width) / 2);
  const top = Math.floor((side - height) / 2);
  return sharp(trimmed.data)
    .extend({ left, right: side - width - left, top, bottom: side - height - top, background: '#000000' })
    .png()
    .toBuffer();
}

function roundedMask(size) {
  const r = Math.round(size * 0.22);
  return Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}"/></svg>`);
}

const newest = Math.max((await stat(source)).mtimeMs, (await stat(script)).mtimeMs);
await mkdir(resolve(root, 'public/icon'), { recursive: true });
let tile;

for (const { size, file } of outputs) {
  const target = resolve(root, file);
  try {
    if ((await stat(target)).mtimeMs >= newest) continue; // up to date
  } catch {
    /* does not exist yet */
  }
  tile ??= await squareTile();
  await sharp(tile)
    .resize(size, size, { kernel: 'lanczos3' })
    .ensureAlpha()
    .composite([{ input: roundedMask(size), blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toFile(target);
  console.log(`[icons] ${file} (${size}px)`);
}
