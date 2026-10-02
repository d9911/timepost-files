import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { referenceAuthorization } from '../src/modules/access/infrastructure/reference-authorization.js';
import { contentRange } from '../src/modules/files/presentation/http/content-range.js';

test('ссылки доступны только отдельному сервисному токену Posts', async () => {
  const environment = {
    SYSTEM_JWT_SECRET: 's'.repeat(32),
    SYSTEM_JWT_ISSUER: 'issuer',
    SYSTEM_JWT_AUDIENCE: 'audience',
  };
  const auth = referenceAuthorization(environment);
  const token = (serviceId: string, permissions: string[], tokenType = 'system') =>
    jwt.sign({ serviceId, permissions, tokenType }, environment.SYSTEM_JWT_SECRET, {
      algorithm: 'HS256',
      issuer: 'issuer',
      audience: 'audience',
      expiresIn: 60,
    });
  await auth(`Bearer ${token('posts-service', ['files:references:write'])}`);
  await assert.rejects(auth(`Bearer ${token('files-service', ['files:references:write'])}`));
  await assert.rejects(auth(`Bearer ${token('posts-service', [])}`));
  await assert.rejects(
    auth(`Bearer ${token('posts-service', ['files:references:write'], 'user')}`),
  );
  await assert.rejects(
    auth(
      `Bearer ${jwt.sign({ tokenType: 'system', serviceId: 'posts-service', permissions: ['files:references:write'] }, environment.SYSTEM_JWT_SECRET, { issuer: 'issuer', audience: 'audience' })}`,
    ),
  );
  await assert.rejects(auth(undefined));
});

test('диапазоны содержимого поддерживают суффиксы и отвергают неоднозначные запросы', () => {
  assert.deepEqual(contentRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(contentRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(contentRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(contentRange('bytes=2-100', 10), { start: 2, end: 9 });
  for (const header of [
    'bytes=10-',
    'bytes=4-2',
    'bytes=-0',
    'bytes=1-2,4-5',
    'bytes=-',
    'bytes=9007199254740992-',
  ])
    assert.equal(contentRange(header, 10), false);
});
