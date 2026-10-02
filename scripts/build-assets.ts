import { cp, mkdir } from 'node:fs/promises';

// Компилятор сохраняет структуру каталогов; runtime получает UI и тестовые fixtures.
const root = new URL('../../', import.meta.url);
await mkdir(new URL('dist/public/', root), { recursive: true });
for (const name of ['index.html', 'style.css']) {
  await cp(new URL(`public/${name}`, root), new URL(`dist/public/${name}`, root));
}
await cp(new URL('test/fixtures/', root), new URL('dist/test/fixtures/', root), {
  recursive: true,
});
