import jwt from 'jsonwebtoken';

import { FileError } from './errors.mjs';

async function jsonResponse(url, authorization, request) {
  let response;
  try {
    response = await request(url, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  } catch {
    throw new FileError(503, 'AUTH_DEPENDENCY_UNAVAILABLE', 'Сервис проверки доступа недоступен');
  }
  if (response.status === 401 || response.status === 403)
    throw new FileError(401, 'UNAUTHORIZED', 'Требуется действующая сессия');
  if (!response.ok)
    throw new FileError(503, 'AUTH_DEPENDENCY_UNAVAILABLE', 'Не удалось проверить доступ');
  let value;
  try {
    value = await response.json();
  } catch {
    throw new FileError(503, 'AUTH_DEPENDENCY_UNAVAILABLE', 'Неверный ответ сервиса доступа');
  }
  return value?.success === true ? value.data : value;
}

export function createAuthorization(environment, request = fetch) {
  const accounts = new URL('/api/v1/auth/introspect', environment.ACCOUNTS_SERVICE_URL);
  return {
    async authenticate(authorization) {
      if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization))
        throw new FileError(401, 'UNAUTHORIZED', 'Требуется сессия');
      const account = await jsonResponse(accounts, authorization, request);
      if (
        account?.active !== true ||
        account.tokenType !== 'user' ||
        typeof account.userId !== 'string' ||
        !/^\d+$/.test(account.userId ?? '')
      )
        throw new FileError(401, 'UNAUTHORIZED', 'Сессия недействительна');
      return account.userId;
    },
    async authorizeProject(userId, projectId, write) {
      const token = jwt.sign(
        {
          tokenType: 'system',
          serviceId: 'files-service',
          permissions: ['projects:read:any'],
        },
        environment.SYSTEM_JWT_SECRET,
        {
          algorithm: 'HS256',
          issuer: environment.SYSTEM_JWT_ISSUER,
          audience: environment.SYSTEM_JWT_AUDIENCE,
          expiresIn: 60,
        },
      );
      const url = new URL(
        `/api/v1/internal/projects/${projectId}/access/${userId}`,
        environment.PROJECTS_SERVICE_URL,
      );
      const access = await jsonResponse(url, `Bearer ${token}`, request);
      if (
        access?.projectId !== projectId ||
        access?.userId !== userId ||
        typeof access?.isActive !== 'boolean' ||
        access?.isDeleted !== false ||
        !['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].includes(access.role) ||
        (write && (!access.isActive || !['OWNER', 'ADMIN', 'MEMBER'].includes(access.role)))
      ) {
        throw new FileError(403, 'PROJECT_FORBIDDEN', 'Недостаточно прав на проект');
      }
    },
  };
}
