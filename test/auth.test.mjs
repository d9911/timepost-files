import assert from 'node:assert/strict';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import { createAuthorization } from '../src/auth.mjs';

const environment = {
  ACCOUNTS_SERVICE_URL: 'http://accounts:3000',
  PROJECTS_SERVICE_URL: 'http://projects:3001',
  SYSTEM_JWT_SECRET: 'test-system-secret-with-at-least-32-characters',
  SYSTEM_JWT_ISSUER: 'test-issuer',
  SYSTEM_JWT_AUDIENCE: 'test-audience',
};
const access = { projectId: '3', userId: '1', role: 'MEMBER', isActive: true, isDeleted: false };

test('проверяет пользовательскую сессию через Accounts и ограниченный системный JWT через Projects', async () => {
  const authorization = createAuthorization(environment, async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.hostname === 'accounts') {
      assert.equal(url.pathname, '/api/v1/auth/introspect');
      assert.equal(options.headers.Authorization, 'Bearer user-token');
      return Response.json({ active: true, tokenType: 'user', userId: '1' });
    }
    assert.equal(url.pathname, '/api/v1/internal/projects/3/access/1');
    const token = jwt.verify(
      options.headers.Authorization.slice(7),
      environment.SYSTEM_JWT_SECRET,
      {
        issuer: environment.SYSTEM_JWT_ISSUER,
        audience: environment.SYSTEM_JWT_AUDIENCE,
        algorithms: ['HS256'],
      },
    );
    assert.equal(token.tokenType, 'system');
    assert.deepEqual(token.permissions, ['projects:read:any']);
    assert.equal(token.exp - token.iat, 60);
    return Response.json(access);
  });
  assert.equal(await authorization.authenticate('Bearer user-token'), '1');
  await authorization.authorizeProject('1', '3', true);
  await assert.rejects(authorization.authenticate('invalid'), (error) => error.status === 401);
});

test('VIEWER читает, но не загружает; удалённый проект и неверный scope не открывают доступ', async () => {
  let response = { ...access, role: 'VIEWER' };
  const authorization = createAuthorization(environment, async () => Response.json(response));
  await authorization.authorizeProject('1', '3', false);
  await assert.rejects(
    authorization.authorizeProject('1', '3', true),
    (error) => error.status === 403,
  );
  for (const patch of [
    { isDeleted: true },
    { isDeleted: undefined },
    { projectId: '4' },
    { userId: '2' },
    { role: null },
  ]) {
    response = { ...access, ...patch };
    await assert.rejects(
      authorization.authorizeProject('1', '3', false),
      (error) => error.status === 403,
    );
  }
});

test('не принимает системный токен как пользователя и не разрешает доступ при сбое зависимости', async () => {
  const system = createAuthorization(environment, async () =>
    Response.json({ active: true, tokenType: 'system', userId: '1' }),
  );
  await assert.rejects(system.authenticate('Bearer system-token'), (error) => error.status === 401);
  const unavailable = createAuthorization(environment, async () => {
    throw new Error('network');
  });
  await assert.rejects(
    unavailable.authenticate('Bearer user-token'),
    (error) => error.status === 503,
  );
  const malformed = createAuthorization(environment, async () => new Response('not-json'));
  await assert.rejects(
    malformed.authenticate('Bearer user-token'),
    (error) => error.status === 503,
  );
});
