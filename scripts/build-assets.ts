import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

// Компилятор сохраняет структуру каталогов; runtime получает UI и тестовые fixtures.
const root = new URL('../../', import.meta.url);
await mkdir(new URL('dist/public/', root), { recursive: true });
for (const name of ['index.html', 'style.css', 'favicon.ico', 'manifest.webmanifest', 'icons']) {
  await cp(new URL(`public/${name}`, root), new URL(`dist/public/${name}`, root), {
    recursive: true,
  });
}
await cp(new URL('test/fixtures/', root), new URL('dist/test/fixtures/', root), {
  recursive: true,
});

// Версия оболочки меняется при изменении любого её ресурса, включая сам worker.
const shellFiles = [
  'index.html',
  'app.js',
  'preferences.js',
  'pwa.js',
  'style.css',
  'manifest.webmanifest',
  'favicon.ico',
  'icons/favicon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192x192.png',
  'icons/icon-512x512.png',
  'icons/maskable-512x512.png',
];
const workerFile = new URL('dist/public/sw.js', root);
const workerSource = await readFile(workerFile, 'utf8');
const hash = createHash('sha256').update(
  workerSource.replace(
    /timepost-files-shell-[a-f0-9]{16}/g,
    'timepost-files-shell-__FILES_CACHE_VERSION__',
  ),
);
for (const name of shellFiles) hash.update(await readFile(new URL(`dist/public/${name}`, root)));
await writeFile(
  workerFile,
  workerSource.replace(
    /__FILES_CACHE_VERSION__|(?<=timepost-files-shell-)[a-f0-9]{16}/g,
    hash.digest('hex').slice(0, 16),
  ),
);
