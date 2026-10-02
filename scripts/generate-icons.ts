import { iconSizes } from '../src/shared/domain/branding.js';
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const source = await readFile(new URL('assets/branding/icon.svg', root));
const directory = new URL('public/icons/', root);
await mkdir(directory, { recursive: true });
await writeFile(new URL('favicon.svg', directory), source);
for (const size of iconSizes)
  await sharp(source)
    .resize(size, size)
    .png()
    .toFile(new URL(`icon-${size}x${size}.png`, directory).pathname);
await sharp(source)
  .resize(180, 180)
  .png()
  .toFile(new URL('apple-touch-icon.png', directory).pathname);
// Для maskable-иконки знак помещён в безопасную центральную область.
const maskable = await sharp(source).resize(320, 320).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#252723' } })
  .composite([{ input: maskable, left: 96, top: 96 }])
  .png()
  .toFile(new URL('maskable-512x512.png', directory).pathname);
// ICO содержит PNG размером 32×32; заголовок и запись каталога задаются явно.
const png = await sharp(source).resize(32, 32).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 32;
header[7] = 32;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await writeFile(new URL('public/favicon.ico', root), Buffer.concat([header, png]));
await sharp(new URL('assets/screenshots/storage-desktop.png', root).pathname)
  .resize(1200, 630, { fit: 'contain', background: '#f4f3ed' })
  .png()
  .toFile(new URL('social-preview.png', directory).pathname);
const manifest = {
  name: 'Timepost Files',
  short_name: 'Files',
  description: 'Private file storage',
  id: '/',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f4f3ed',
  theme_color: '#252723',
  lang: 'en',
  icons: [...iconSizes]
    .map((size) => ({
      src: `/icons/icon-${size}x${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any',
    }))
    .concat([
      {
        src: '/icons/maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]),
};
await writeFile(
  new URL('public/manifest.webmanifest', root),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log('Иконки, favicon, social preview и manifest созданы.');
