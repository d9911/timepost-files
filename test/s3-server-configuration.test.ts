import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureS3 } from '../src/app/s3-configuration.js';

const environment = {
  FILES_S3_ENABLED: 'true',
  FILES_S3_ACCESS_KEY_ID: 'local-test',
  FILES_S3_SECRET_ACCESS_KEY: 'x'.repeat(32),
};
test('native S3 is opt-in and uses independent credentials and safe bounds', () => {
  assert.equal(configureS3({}), undefined);
  assert.throws(
    () =>
      configureS3({
        FILES_S3_ENABLED: 'true',
        S3_ACCESS_KEY_ID: 'cloud',
        S3_SECRET_ACCESS_KEY: 'cloud',
      }),
    /Native S3 requires/,
  );
  const config = configureS3(environment)!;
  assert.equal(config.port, 3051);
  assert.equal(config.directory, '/data/s3');
  assert.equal(config.maxObjectBytes, 10_000_000_000);
  assert.equal(config.credentials.accessKeyId, 'local-test');
  assert.throws(() => configureS3({ ...environment, FILES_S3_PORT: '0' }), /Invalid FILES_S3_PORT/);
  assert.throws(
    () => configureS3({ ...environment, FILES_S3_MAX_OBJECT_BYTES: '-1' }),
    /Invalid FILES_S3_MAX_OBJECT_BYTES/,
  );
});
test('native S3 CORS requires explicit origins', () => {
  assert.deepEqual(
    configureS3({
      ...environment,
      FILES_S3_CORS_ORIGINS: 'http://localhost:3000, https://app.example.com',
    })?.credentials.corsOrigins,
    ['http://localhost:3000', 'https://app.example.com'],
  );
  assert.throws(
    () => configureS3({ ...environment, FILES_S3_CORS_ORIGINS: 'https://app.example.com/path' }),
    /explicit HTTP origins/,
  );
});
