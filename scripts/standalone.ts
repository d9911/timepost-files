import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { standaloneArguments } from './standalone-config.js';
import type { StandaloneAction } from './standalone-config.js';

const actions: readonly string[] = [
  'start',
  'stop',
  'ps',
  'logs',
  'smoke',
  'config',
  'test-db',
  'test-references',
];
const [action, executable = 'docker', ...prefix] = process.argv.slice(2);
if (!action || !actions.includes(action)) throw new Error('Неизвестная команда автономного Files');
const root = fileURLToPath(new URL('../../', import.meta.url));
const fileEnv = parseEnv(await readFile(new URL('../../.env', import.meta.url), 'utf8'));
// Переменные оболочки имеют приоритет, как при обычном запуске Docker Compose.
const environment = { ...fileEnv, ...process.env };
const args = standaloneArguments(action as StandaloneAction, environment);
const child = spawn(executable, [...prefix, ...args], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});
child.on('error', (error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
