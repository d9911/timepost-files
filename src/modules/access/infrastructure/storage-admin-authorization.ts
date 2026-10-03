import jwt from 'jsonwebtoken';
import type { Environment } from '../../../shared/infrastructure/environment.js';
import { FileError } from '../../../shared/application/file-error.js';
export function storageAdminAuthorization(environment: Environment) {
  return async (header: string | undefined): Promise<string> => {
    try {
      if (!header?.startsWith('Bearer ')) throw new Error('token');
      if (!environment.SYSTEM_JWT_SECRET || environment.SYSTEM_JWT_SECRET.length < 32)
        throw new Error('configuration');
      const claims = jwt.verify(header.slice(7), environment.SYSTEM_JWT_SECRET ?? '', {
        algorithms: ['HS256'],
        issuer: environment.SYSTEM_JWT_ISSUER,
        audience: environment.SYSTEM_JWT_AUDIENCE,
      });
      if (
        typeof claims === 'string' ||
        claims.tokenType !== 'system' ||
        claims.serviceId !== 'admin-service' ||
        typeof claims.sub !== 'string' ||
        !/^\d+$/.test(claims.sub) ||
        typeof claims.exp !== 'number' ||
        typeof claims.iat !== 'number' ||
        claims.exp - claims.iat > 60 ||
        claims.exp <= claims.iat ||
        claims.iat > Math.floor(Date.now() / 1000) + 5 ||
        !Array.isArray(claims.permissions) ||
        !claims.permissions.includes('files:admin')
      )
        throw new Error('scope');
      return claims.sub;
    } catch {
      throw new FileError('UNAUTHORIZED', 'Требуется защищённая административная сессия');
    }
  };
}
