import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { parseStorageSettings } from '../src/modules/files/application/storage-admin-service.js';
import { storageAdminAuthorization } from '../src/modules/access/infrastructure/storage-admin-authorization.js';
const settings = {
  planId: 'business',
  maxFileBytes: 10000000000,
  quotaBytes: null,
  concurrentUploads: 4,
  retentionDays: 90,
  uploadsEnabled: true,
  retentionEnabled: false,
};
test('профили хранения принимают точные целые лимиты и наследование, и включение/отключение автоудаления', () => {
  assert.deepEqual(parseStorageSettings(settings, true), settings);
  assert.equal(
    parseStorageSettings({ ...settings, retentionEnabled: true }).retentionEnabled,
    true,
  );
  assert.deepEqual(parseStorageSettings({ ...settings, maxFileBytes: null }), {
    ...settings,
    maxFileBytes: null,
  });
  for (const invalid of [
    { maxFileBytes: 10000000001 },
    { quotaBytes: -1 },
    { concurrentUploads: 0 },
    { concurrentUploads: 33 },
    { retentionDays: 0 },
    { retentionEnabled: 'true' },
    { planId: 'unknown' },
    { maxFileBytes: 1.5 },
    { extra: true },
    { uploadsEnabled: 'true' },
    { maxFileBytes: undefined },
  ])
    assert.throws(() => parseStorageSettings({ ...settings, ...invalid }));
  assert.throws(() => parseStorageSettings({ ...settings, maxFileBytes: null }, true));
});
test('административный канал принимает только короткий системный токен с субъектом и scope Files', async () => {
  const environment = {
    SYSTEM_JWT_SECRET: 's'.repeat(32),
    SYSTEM_JWT_ISSUER: 'issuer',
    SYSTEM_JWT_AUDIENCE: 'audience',
  };
  const authorize = storageAdminAuthorization(environment);
  const sign = (claims: Record<string, unknown> = {}, expiresIn = 60) =>
    jwt.sign(
      {
        sub: '12',
        tokenType: 'system',
        serviceId: 'admin-service',
        permissions: ['files:admin'],
        ...claims,
      },
      environment.SYSTEM_JWT_SECRET,
      { issuer: 'issuer', audience: 'audience', expiresIn },
    );
  assert.equal(await authorize(`Bearer ${sign()}`), '12');
  for (const token of [
    sign({}, 61),
    sign({ tokenType: 'user' }),
    sign({ serviceId: 'posts-service' }),
    sign({ permissions: [] }),
    sign({ sub: 'admin' }),
    sign({}, -1),
  ])
    await assert.rejects(authorize(`Bearer ${token}`));
  await assert.rejects(authorize(undefined));
  await assert.rejects(storageAdminAuthorization({})(`Bearer ${sign()}`));
});
