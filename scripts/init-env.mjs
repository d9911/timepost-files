import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const key = () => randomBytes(32).toString('hex');
try {
  await writeFile(
    new URL('../.env', import.meta.url),
    `# Локальные секреты. Не добавляйте этот файл в Git.\nFILES_API_KEY=${key()}\nFILES_READONLY_API_KEY=${key()}\nFILES_DB_PASSWORD=${key()}\nSTORAGE_PROVIDER=simulator\nFILES_PORT=3060\nYANDEX_DISK_OAUTH_TOKEN=\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Создан files/.env; секреты не выводятся.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Используется существующий files/.env; настройки сохранены.');
}
