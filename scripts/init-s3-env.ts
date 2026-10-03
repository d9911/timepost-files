import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { configureLocalS3 } from './local-s3-settings.js';

const path = new URL('../../.env', import.meta.url);
const temporary = new URL(`../../.env.${randomUUID()}.tmp`, import.meta.url);
const source = configureLocalS3(await readFile(path, 'utf8'));
// Атомарная замена исключает частично записанный файл настроек.
try {
  await writeFile(temporary, source, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
} finally {
  await rm(temporary, { force: true });
}
console.log(
  'Локальный S3 настроен в общем .env. Ключи Files и БД сохранены; смена провайдера не переносит файлы.',
);
