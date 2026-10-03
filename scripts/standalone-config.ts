export type StandaloneAction =
  | 'start'
  | 'stop'
  | 'ps'
  | 'logs'
  | 'smoke'
  | 'config'
  | 'test-db'
  | 'test-references';
export type StandaloneEnvironment = Readonly<Record<string, string | undefined>>;

export function standaloneArguments(
  action: StandaloneAction,
  env: StandaloneEnvironment,
): string[] {
  const localS3 = env.STORAGE_PROVIDER === 's3' && env.S3_ENDPOINT === 'http://s3mock:9090';
  if (localS3 && env.S3_ALLOW_INSECURE_LOCAL !== 'true') {
    throw new Error('Локальный S3 требует S3_ALLOW_INSECURE_LOCAL=true');
  }
  const args = ['--env-file', '.env', '-p', 'timepost-files-standalone', '-f', 'compose.yaml'];
  if (localS3) args.push('-f', 'compose.s3.yaml');
  switch (action) {
    case 'start':
      return [...args, 'up', '--detach', '--build', '--wait', '--remove-orphans'];
    case 'stop':
      return [...args, 'stop'];
    case 'ps':
      return [...args, 'ps'];
    case 'config':
      return [...args, 'config', '--quiet'];
    case 'logs':
      return [
        ...args,
        'logs',
        '--tail',
        '80',
        'api',
        'worker',
        ...(localS3 ? ['s3mock', 's3-init'] : []),
      ];
    case 'smoke':
      return [...args, 'exec', '-T', 'api', 'node', 'dist/scripts/smoke.js'];
    case 'test-db':
      return [...args, 'exec', '-T', 'api', 'node', 'dist/scripts/database-check.js'];
    case 'test-references':
      return [...args, 'exec', '-T', 'api', 'node', 'dist/scripts/references-check.js'];
  }
}
