import { parseEnv } from 'node:util';
import { configureLocalS3 } from '../scripts/local-s3-settings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standaloneArguments } from '../scripts/standalone-config.js';

test('все провайдеры запускают один проект Files с общей конфигурацией', () => {
  for (const provider of ['simulator', 'yandex', 's3', 'aws', 'selectel', 'yandex-object']) {
    const args = standaloneArguments('start', { STORAGE_PROVIDER: provider });
    assert.equal(args[args.indexOf('-p') + 1], 'timepost-files-standalone');
    assert.equal(args[args.indexOf('--env-file') + 1], '.env');
    assert.ok(!args.includes('compose.s3.yaml'));
    assert.ok(!args.includes('--volumes'));
  }
});
test('эмулятор подключается только для явно разрешённого локального S3', () => {
  const env = {
    STORAGE_PROVIDER: 's3',
    S3_ENDPOINT: 'http://s3mock:9090',
    S3_ALLOW_INSECURE_LOCAL: 'true',
  };
  for (const action of ['start', 'stop', 'logs', 'config', 'smoke'] as const) {
    assert.ok(standaloneArguments(action, env).includes('compose.s3.yaml'));
  }
  assert.throws(() => standaloneArguments('start', { ...env, S3_ALLOW_INSECURE_LOCAL: 'false' }));
  assert.ok(
    !standaloneArguments('start', { ...env, S3_ENDPOINT: 'https://storage.example.org' }).includes(
      'compose.s3.yaml',
    ),
  );
});

test('выбор локального S3 сохраняет ключи, пароль БД, порт и повторно использует настройки', () => {
  const original =
    'FILES_API_KEY=owner\nFILES_READONLY_API_KEY=reader\nFILES_DB_PASSWORD=password\nFILES_PORT=3070\nSTORAGE_PROVIDER=simulator\nS3_ENDPOINT=\n';
  const result = configureLocalS3(original);
  const env = parseEnv(result);
  for (const key of [
    'FILES_API_KEY',
    'FILES_READONLY_API_KEY',
    'FILES_DB_PASSWORD',
    'FILES_PORT',
  ]) {
    assert.equal(env[key], parseEnv(original)[key]);
  }
  assert.equal(env.STORAGE_PROVIDER, 's3');
  assert.equal(env.S3_ENDPOINT, 'http://s3mock:9090');
  assert.equal(configureLocalS3(result), result);
});

test('локальная настройка не перезаписывает чужой облачный провайдер или endpoint', () => {
  assert.throws(() => configureLocalS3('STORAGE_PROVIDER=aws\n'));
  assert.throws(() =>
    configureLocalS3('STORAGE_PROVIDER=s3\nS3_ENDPOINT=https://cloud.example.org\n'),
  );
});
