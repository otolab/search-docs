import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rmdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const source = await readFile(path.join(repo, 'packages/db-engine/src/typescript/maintenance-lock.ts'), 'utf8');
const root = await mkdtemp(path.join(tmpdir(), 'issue183-manual-registration-'));

async function sharedOutcome(lock) {
  try {
    const release = await lock.acquireShared();
    await release();
    return 'allowed';
  } catch (error) {
    return `denied: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function exclusiveOutcome(lock, options) {
  try {
    const lease = await lock.acquireExclusive(options);
    await lease.release();
    return 'allowed';
  } catch (error) {
    return `denied: ${error instanceof Error ? error.message : String(error)}`;
  }
}

try {
  const modulePath = path.join(root, 'maintenance-lock.mjs');
  await writeFile(modulePath, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
  const { MaintenanceLock, strictMaintenanceLock } = await import(pathToFileURL(modulePath).href);

  const projectRoot = path.join(root, 'project');
  const storageParent = path.join(projectRoot, '.search-docs');
  await mkdir(storageParent, { recursive: true });
  const canonicalRoot = await realpath(projectRoot);
  const canonicalStorageParent = await realpath(storageParent);
  const strictLock = await strictMaintenanceLock({
    projectRoot,
    indexPath: '.search-docs/index',
    documentsPath: '.search-docs/documents',
    files: { sources: ['**/*.md'], exclude: [], respectGitignore: true },
  });
  const managementPath = path.join(canonicalStorageParent, '.search-docs-maintenance');
  await strictLock.acquireShared();
  const usersPath = path.join(managementPath, 'users');
  const [registrationId] = await readdir(usersPath);
  const registrationPath = path.join(usersPath, registrationId);
  const identityPath = path.join(registrationPath, 'identity');
  const identityText = await readFile(identityPath, 'utf8');
  const identity = JSON.parse(identityText);

  assert.deepEqual(identity, {
    root: canonicalRoot,
    index: path.join(canonicalStorageParent, 'index'),
    documents: path.join(canonicalStorageParent, 'documents'),
    files: { sources: ['**/*.md'], exclude: [], respectGitignore: true },
  });
  assert.deepEqual(Object.keys(identity).sort(), ['documents', 'files', 'index', 'root']);
  assert.equal(path.basename(managementPath), '.search-docs-maintenance');

  const projectAlias = path.join(root, 'project-alias');
  await symlink(projectRoot, projectAlias, 'dir');
  const aliasLock = await strictMaintenanceLock({
    projectRoot: projectAlias,
    indexPath: '.search-docs/index',
    documentsPath: '.search-docs/documents',
    files: { sources: ['**/*.md'], exclude: [], respectGitignore: true },
  });
  const releaseAlias = await aliasLock.acquireShared();
  const aliasRegistration = (await readdir(usersPath))[0];
  const aliasIdentity = await readFile(path.join(usersPath, aliasRegistration, 'identity'), 'utf8');
  assert.equal(aliasIdentity, identityText);
  await releaseAlias();

  // Model an in-progress lock critical section using only this disposable fixture.
  // Direct filesystem removal does not consult or acquire this gate.
  const gatePath = path.join(managementPath, 'gate');
  await mkdir(gatePath);
  await unlink(identityPath);
  await rmdir(registrationPath);
  const gateStillPresent = (await readdir(managementPath)).includes('gate');

  let exclusiveWhileGatePresent;
  try {
    const lease = await new MaintenanceLock(managementPath).acquireExclusive();
    await lease.release();
    exclusiveWhileGatePresent = 'allowed';
  } catch (error) {
    exclusiveWhileGatePresent = `denied: ${error instanceof Error ? error.message : String(error)}`;
  }
  assert.match(exclusiveWhileGatePresent, /^denied: .*残存ロック/);

  await rmdir(gatePath);
  const exclusive = await new MaintenanceLock(managementPath).acquireExclusive();
  const sameIdentityWhileExclusive = await (async () => {
    try {
      const release = await new MaintenanceLock(managementPath, identityText).acquireShared();
      await release();
      return 'allowed';
    } catch (error) {
      return `denied: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();
  assert.match(sameIdentityWhileExclusive, /^denied: .*保守操作/);
  await exclusive.release();

  const releaseAfterRemoval = await new MaintenanceLock(managementPath, identityText).acquireShared();
  await releaseAfterRemoval();

  const missingIdentityPath = path.join(root, 'missing-identity');
  await mkdir(path.join(missingIdentityPath, 'users', randomUUID()), { recursive: true });
  const missingIdentityShared = await sharedOutcome(new MaintenanceLock(missingIdentityPath, identityText));
  assert.match(missingIdentityShared, /^denied: .*設定を確認できません/);

  const mismatchedIdentityPath = path.join(root, 'mismatched-identity');
  const mismatchedRegistration = path.join(mismatchedIdentityPath, 'users', randomUUID());
  await mkdir(mismatchedRegistration, { recursive: true });
  await writeFile(path.join(mismatchedRegistration, 'identity'), '{"root":"another-project"}');
  const mismatchedIdentityShared = await sharedOutcome(new MaintenanceLock(mismatchedIdentityPath, identityText));
  assert.match(mismatchedIdentityShared, /^denied: .*異なるプロジェクト設定/);

  const exclusivePath = path.join(root, 'orphan-exclusive');
  await mkdir(path.join(exclusivePath, 'users'), { recursive: true });
  await mkdir(path.join(exclusivePath, 'exclusive'));
  const sharedWithExclusive = await sharedOutcome(new MaintenanceLock(exclusivePath, identityText));
  const exclusiveWithExclusive = await exclusiveOutcome(new MaintenanceLock(exclusivePath));
  assert.match(sharedWithExclusive, /^denied: .*保守操作/);
  assert.match(exclusiveWithExclusive, /^denied: .*保守操作/);

  const incompletePath = path.join(root, 'incomplete');
  await mkdir(path.join(incompletePath, 'users'), { recursive: true });
  await mkdir(path.join(incompletePath, 'incomplete'));
  const sharedWithIncomplete = await sharedOutcome(new MaintenanceLock(incompletePath, identityText));
  const completeOnlyExclusive = await exclusiveOutcome(new MaintenanceLock(incompletePath), { requireComplete: true });
  const ordinaryExclusive = await exclusiveOutcome(new MaintenanceLock(incompletePath));
  const incompletePreserved = (await readdir(incompletePath)).includes('incomplete');
  assert.match(sharedWithIncomplete, /^denied: .*未完了/);
  assert.match(completeOnlyExclusive, /^denied: .*未完了/);
  assert.equal(ordinaryExclusive, 'allowed');
  assert.equal(incompletePreserved, true);

  process.stdout.write(`${JSON.stringify({
    fixtureOnly: true,
    managementPath,
    registrationIdentityKeys: Object.keys(identity).sort(),
    registrationContainsProcessOwner: false,
    symlinkAliasUsesSameCanonicalIdentity: true,
    directRemovalWhileGatePresent: true,
    gateStillPresent,
    exclusiveWhileGatePresent,
    sameIdentityWhileExclusive,
    sameIdentityAfterRemoval: 'allowed',
    ownerUnknownUuid: 'identity matches target but no process owner is recorded; human inventory required',
    missingIdentityShared: missingIdentityShared,
    mismatchedIdentityShared: mismatchedIdentityShared,
    sharedWithExclusive,
    exclusiveWithExclusive,
    sharedWithIncomplete,
    requireCompleteExclusiveWithIncomplete: completeOnlyExclusive,
    ordinaryExclusiveWithIncomplete: ordinaryExclusive,
    incompletePreserved,
    liveDatabaseOrProcessUsed: false,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
