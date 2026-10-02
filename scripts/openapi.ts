import { readFile, writeFile } from 'node:fs/promises';

import { fileOpenApi } from '../src/modules/files/presentation/openapi/document.js';

const path = new URL('../../openapi.json', import.meta.url);
const source = JSON.stringify(fileOpenApi, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8')) !== source)
    throw new Error('OpenAPI устарел: выполните npm run openapi:generate');
} else await writeFile(path, source);
console.log('OpenAPI Files актуален; HTTP Swagger не включался.');
