// Erzeugt aus logo.png alle Icon-Größen für das Manifest (public/icon/<size>.png)
// und eine kleinere Variante für die UI (public/logo-ui.png).
// logo.png selbst wird nur gelesen, nie verändert.
import sharp from 'sharp';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'logo.png');
const outputs = [
  ...[16, 32, 48, 128].map((size) => ({ size, file: `public/icon/${size}.png` })),
  { size: 256, file: 'public/logo-ui.png' },
];

const srcStat = await stat(source);
await mkdir(resolve(root, 'public/icon'), { recursive: true });

for (const { size, file } of outputs) {
  const target = resolve(root, file);
  try {
    const t = await stat(target);
    if (t.mtimeMs >= srcStat.mtimeMs) continue; // aktuell – nichts zu tun
  } catch {
    /* existiert noch nicht */
  }
  await sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(target);
  console.log(`[icons] ${file} (${size}px)`);
}
