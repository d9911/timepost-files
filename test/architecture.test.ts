import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}

test('границы Clean Architecture запрещают зависимости ядра от адаптеров и транспорта', async () => {
  for (const path of await sources(sourceRoot)) {
    const owner = relative(sourceRoot, path).replaceAll('\\', '/');
    const tree = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const literal = statement.moduleSpecifier;
      if (!literal || !ts.isStringLiteral(literal)) continue;
      const dependency = literal.text;
      const target = dependency.startsWith('.')
        ? relative(sourceRoot, resolve(dirname(path), dependency)).replaceAll('\\', '/')
        : dependency;
      const evidence = `${owner} → ${target}`;
      if (owner.includes('/domain/')) {
        assert.ok(target.startsWith(owner.split('/domain/')[0]! + '/domain/'), evidence);
      }
      if (owner.includes('/application/')) {
        assert.ok(dependency.startsWith('.'), evidence);
        assert.ok(!/(?:^|\/)(infrastructure|presentation|app)\//.test(target), evidence);
      }
      if (owner.includes('/infrastructure/')) {
        assert.ok(!/(?:^|\/)(presentation|app)\//.test(target), evidence);
      }
      if (owner.startsWith('shared/'))
        assert.ok(!target.startsWith('modules/') && !target.startsWith('app/'), evidence);
      const ownerModule = /^modules\/([^/]+)\//.exec(owner)?.[1];
      const targetModule = /^modules\/([^/]+)\//.exec(target)?.[1];
      if (ownerModule && targetModule && ownerModule !== targetModule) {
        assert.equal(target, `modules/${targetModule}/contracts.js`, evidence);
      }
    }
  }
});
