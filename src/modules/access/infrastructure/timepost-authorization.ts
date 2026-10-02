import { requestId } from '../../../shared/infrastructure/request-context.js';
import type { Authorization } from '../application/authorization.js';
import type { Environment } from '../../../shared/infrastructure/environment.js';
import type { HttpRequest } from '../../../shared/infrastructure/http-request.js';
import { isRecord } from '../../../shared/guards/is-record.js';
import jwt from 'jsonwebtoken';

import { FileError } from '../../../shared/application/file-error.js';

async function jsonResponse(
  url: URL,
  authorization: string,
  request: HttpRequest,
): Promise<Record<string, unknown>> {
  let response;
  try {
    response = await request(url, {
      headers: {
        Authorization: authorization,
        ...(requestId() ? { 'X-Request-Id': requestId()! } : {}),
      },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  } catch {
    throw new FileError('AUTH_DEPENDENCY_UNAVAILABLE', 'Сервис проверки доступа недоступен');
  }
  if (response.status === 401 || response.status === 403)
    throw new FileError('UNAUTHORIZED', 'Требуется действующая сессия');
  if (!response.ok)
    throw new FileError('AUTH_DEPENDENCY_UNAVAILABLE', 'Не удалось проверить доступ');
  let value;
  try {
    value = await response.json();
  } catch {
    throw new FileError('AUTH_DEPENDENCY_UNAVAILABLE', 'Неверный ответ сервиса доступа');
  }
  if (!isRecord(value))
    throw new FileError('AUTH_DEPENDENCY_UNAVAILABLE', 'Неверный ответ сервиса доступа');
  const result: unknown = value.success === true ? value.data : value;
  if (!isRecord(result))
    throw new FileError('AUTH_DEPENDENCY_UNAVAILABLE', 'Неверный ответ сервиса доступа');
  return result;
}

export function createAuthorization(
  environment: Environment,
  request: HttpRequest = fetch,
): Authorization {
  const accounts = new URL('/api/v1/auth/introspect', environment.ACCOUNTS_SERVICE_URL ?? '');
  return {
    async authenticate(authorization) {
      if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization))
        throw new FileError('UNAUTHORIZED', 'Требуется сессия');
      const account = await jsonResponse(accounts, authorization, request);
      if (
        account?.active !== true ||
        account.tokenType !== 'user' ||
        typeof account.userId !== 'string' ||
        !/^\d+$/.test(account.userId ?? '')
      )
        throw new FileError('UNAUTHORIZED', 'Сессия недействительна');
      return account.userId;
    },
    async authorizeProject(userId, projectId, write) {
      const token = jwt.sign(
        {
          tokenType: 'system',
          serviceId: 'files-service',
          permissions: ['projects:read:any'],
        },
        environment.SYSTEM_JWT_SECRET ?? '',
        {
          algorithm: 'HS256',
          issuer: environment.SYSTEM_JWT_ISSUER,
          audience: environment.SYSTEM_JWT_AUDIENCE,
          expiresIn: 60,
        },
      );
      const url = new URL(
        `/api/v1/internal/projects/${projectId}/access/${userId}`,
        environment.PROJECTS_SERVICE_URL ?? '',
      );
      const access = await jsonResponse(url, `Bearer ${token}`, request);
      if (
        access?.projectId !== projectId ||
        access?.userId !== userId ||
        typeof access?.isActive !== 'boolean' ||
        access?.isDeleted !== false ||
        !['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].includes(String(access.role)) ||
        (write && (!access.isActive || !['OWNER', 'ADMIN', 'MEMBER'].includes(String(access.role))))
      ) {
        throw new FileError('PROJECT_FORBIDDEN', 'Недостаточно прав на проект');
      }
    },
  };
}
