import jwt from 'jsonwebtoken';
import type { Environment } from '../../../shared/infrastructure/environment.js';
import { FileError } from '../../../shared/application/file-error.js';

export function referenceAuthorization(environment: Environment) {
  return async (header: string | undefined): Promise<void> => {
    if (!header?.startsWith('Bearer '))
      throw new FileError('UNAUTHORIZED', 'Требуется сервисный токен');
    try {
      const claims = jwt.verify(header.slice(7), environment.SYSTEM_JWT_SECRET ?? '', {
        algorithms: ['HS256'],
        issuer: environment.SYSTEM_JWT_ISSUER,
        audience: environment.SYSTEM_JWT_AUDIENCE,
      });
      if (
        typeof claims === 'string' ||
        claims.tokenType !== 'system' ||
        typeof claims.exp !== 'number' ||
        claims.exp > Date.now() / 1000 + 300 ||
        claims.serviceId !== 'posts-service' ||
        !Array.isArray(claims.permissions) ||
        !claims.permissions.includes('files:references:write')
      )
        throw new Error('Нет доступа');
    } catch {
      throw new FileError('UNAUTHORIZED', 'Недействительный сервисный токен');
    }
  };
}
