import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tempRoot = await mkdtemp(path.join(tmpdir(), 'issue183-source-dist-'));
let completed = false;

function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `${child.spawnfile} exited ${code}/${signal}\n${stdout}${stderr}`,
      ));
    });
  });
}

async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return collect(child);
}

async function extractCommittedSource() {
  const archive = spawn('git', ['archive', 'HEAD'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extract = spawn('tar', ['-x', '-C', tempRoot], {
    cwd: repo,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  archive.stdout.pipe(extract.stdin);
  let archiveStderr = '';
  archive.stderr.setEncoding('utf8');
  archive.stderr.on('data', chunk => { archiveStderr += chunk; });
  const archiveClosed = new Promise((resolve, reject) => {
    archive.once('error', reject);
    archive.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`git archive exited ${code}/${signal}\n${archiveStderr}`));
    });
  });
  const [, extraction] = await Promise.all([archiveClosed, collect(extract)]);
  return extraction;
}

async function hashDistTree(root) {
  const hashes = [];
  const packageEntries = await readdir(path.join(root, 'packages'), { withFileTypes: true });
  for (const packageName of packageEntries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()) {
    const dist = path.join(root, 'packages', packageName, 'dist');
    try { await stat(dist); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    async function visit(directory, relative = '') {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const nextRelative = path.join(relative, entry.name);
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(fullPath, nextRelative);
        else if (entry.isFile()) {
          const hash = createHash('sha256').update(await readFile(fullPath)).digest('hex');
          hashes.push([`${packageName}/dist/${nextRelative}`, hash]);
        }
      }
    }
    await visit(dist);
  }
  return hashes;
}

try {
  const { stdout: sourceCommit } = await run('git', ['rev-parse', 'HEAD'], repo);
  const { stdout: dirtyBuildInputs } = await run(
    'git',
    [
      'status',
      '--porcelain',
      '--',
      'packages',
      'tsconfig.json',
      'tsconfig.base.json',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ],
    repo,
  );
  assert.equal(
    dirtyBuildInputs,
    '',
    'commit or discard build input changes before comparing dist',
  );

  await extractCommittedSource();
  await symlink(path.join(repo, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
  for (const entry of await readdir(path.join(tempRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceModules = path.join(repo, 'packages', entry.name, 'node_modules');
    try { await stat(sourceModules); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await symlink(
      sourceModules,
      path.join(tempRoot, 'packages', entry.name, 'node_modules'),
      'dir',
    );
  }

  await run(process.execPath, [
    path.join(repo, 'node_modules/typescript/bin/tsc'),
    '--build',
    '--force',
    'tsconfig.json',
  ], tempRoot);

  const current = new Map(await hashDistTree(repo));
  const rebuilt = new Map(await hashDistTree(tempRoot));
  const differences = [];
  for (const [file, hash] of current) {
    if (rebuilt.get(file) !== hash) {
      differences.push({ file, kind: rebuilt.has(file) ? 'content' : 'missing-rebuilt' });
    }
  }
  for (const file of rebuilt.keys()) {
    if (!current.has(file)) differences.push({ file, kind: 'missing-current' });
  }

  console.log(JSON.stringify({
    sourceCommit: sourceCommit.trim(),
    buildInputChangeCheck: 'clean',
    currentDistFiles: current.size,
    rebuiltDistFiles: rebuilt.size,
    matching: differences.length === 0,
    differences,
  }, null, 2));
  completed = true;
} catch (error) {
  console.error(`Source/dist check failed; its isolated build is preserved at ${tempRoot}`);
  throw error;
} finally {
  if (completed) await rm(tempRoot, { recursive: true, force: true });
}
