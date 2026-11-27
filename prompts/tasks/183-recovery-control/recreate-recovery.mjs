import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.VIRTUAL_ENV = path.join(repo, 'packages/db-engine/.venv');
process.env.UV_PROJECT_ENVIRONMENT = process.env.VIRTUAL_ENV;
process.env.UV_NO_SYNC = '1';
const python = path.join(repo, 'packages/db-engine/.venv/bin/python');
const requireEnvironment = (file, description) => {
  if (!file) throw new Error(`Required ${description} was not found: ${file}`);
};
requireEnvironment(python, 'Python virtual environment');
const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(repo, 'packages/types/dist/index.js')).href);
const { diagnoseStrictConfig } = await import(pathToFileURL(path.join(repo, 'packages/server/dist/discovery/strict-diagnostic.js')).href);
const { MaintenanceLock } = await import(pathToFileURL(path.join(repo, 'packages/db-engine/dist/index.js')).href);

const root = await mkdtemp(path.join(tmpdir(), 'issue183-recreate-recovery-'));
const pythonSource = path.join(repo, 'packages/db-engine/src/python');
const instrumentedPython = path.join(root, 'instrumented-python');
const dimension = 256;
const apiKey = 'issue183-test-key';
const model = 'issue183-test-model';
const embeddingRequests = [];

const embedding = createServer((request, response) => {
  if (request.url === '/health' || request.url === '/ready') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      status: 'ok',
      ready: true,
      model,
      vectorDimension: dimension,
    }));
    return;
  }
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    embeddingRequests.push({ path: request.url, count: Array.isArray(body.input) ? body.input.length : 0 });
    if (request.url !== '/v1/embeddings' || request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401).end();
      return;
    }
    const vectors = body.input.map(() => [1, ...Array.from({ length: dimension - 1 }, () => 0)]);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    }));
  });
});

await new Promise((resolve, reject) => {
  embedding.once('error', reject);
  embedding.listen(0, '127.0.0.1', resolve);
});
const address = embedding.address();
if (!address || typeof address === 'string') throw new Error('Could not start local embedding fixture');
const baseUrl = `http://127.0.0.1:${address.port}`;
const provider = { provider: 'openai-compatible', baseUrl: `${baseUrl}/v1`, model, apiKey };
const runtimeEnvironment = {
  ...process.env,
  VIRTUAL_ENV: path.join(repo, 'packages/db-engine/.venv'),
  UV_PROJECT_ENVIRONMENT: path.join(repo, 'packages/db-engine/.venv'),
  UV_NO_SYNC: '1',
  PYTHONDONTWRITEBYTECODE: '1',
};
process.env.VIRTUAL_ENV = runtimeEnvironment.VIRTUAL_ENV;
process.env.UV_PROJECT_ENVIRONMENT = runtimeEnvironment.UV_PROJECT_ENVIRONMENT;
process.env.UV_NO_SYNC = runtimeEnvironment.UV_NO_SYNC;
const cliPath = path.join(repo, 'packages/cli/dist/index.js');

function fixtureConfig(projectRoot) {
  return {
    ...DEFAULT_CONFIG,
    project: { ...DEFAULT_CONFIG.project, name: 'issue183-recovery-test', root: projectRoot },
    files: { ...DEFAULT_CONFIG.files, sources: ['*.md'], exclude: [], respectGitignore: false },
    storage: {
      ...DEFAULT_CONFIG.storage,
      indexPath: '.search-docs/index',
      documentsPath: '.search-docs/documents',
    },
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      embeddingUrl: baseUrl,
      embedding: provider,
      vectorDimension: dimension,
    },
    worker: { ...DEFAULT_CONFIG.worker, enabled: false },
  };
}

async function createProject(projectRoot, withSource = true) {
  await mkdir(path.join(projectRoot, '.search-docs/documents'), { recursive: true });
  if (withSource) await writeFile(path.join(projectRoot, 'source.md'), '# Source\n\nRecovery fixture.');
  await writeFile(path.join(projectRoot, '.search-docs.json'), JSON.stringify(fixtureConfig(projectRoot), null, 2));
}

async function runCli(projectRoot, ...args) {
  return execFile(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    env: runtimeEnvironment,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function quiet(action) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try { return await action(); }
  finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function pauseHelper() {
  return `
def _issue183_pause_after_sections():
    if os.environ.get('ISSUE183_PAUSE_AFTER') == 'sections':
        sys.stderr.write('ISSUE183_PAUSED_AFTER:sections\\\\n')
        sys.stderr.flush()
        while True:
            time.sleep(1)
`;
}

async function instrumentWorker() {
  await cp(pythonSource, instrumentedPython, { recursive: true });
  const workerFile = path.join(instrumentedPython, 'worker.py');
  const original = await readFile(workerFile, 'utf8');
  const helperAnchor = 'from pathlib import Path';
  const tableAnchor = 'self.db.create_table(SECTIONS_TABLE, schema=get_sections_schema(self.vector_dimension))';
  assert(original.includes(helperAnchor), 'worker import anchor changed');
  assert(original.includes(tableAnchor), 'sections creation anchor changed');
  const instrumented = original
    .replace(helperAnchor, `${helperAnchor}${pauseHelper()}`)
    .replace(tableAnchor, `${tableAnchor}\n                    _issue183_pause_after_sections()`);
  await writeFile(workerFile, instrumented);
  return workerFile;
}

function waitForMarker(child, marker, timeoutMs = 30000) {
  let buffer = '';
  return Promise.race([
    new Promise((resolve, reject) => {
      child.stderr.on('data', data => {
        buffer += data.toString();
        if (buffer.includes(marker)) resolve(buffer);
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`worker exited before ${marker}: ${code}/${signal}\n${buffer.slice(-2000)}`)));
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function crashAfterSections(projectRoot, workerFile) {
  const indexPath = path.join(projectRoot, '.search-docs/index');
  const env = {
    ...runtimeEnvironment,
    SEARCH_DOCS_EMBEDDING_PROVIDER: provider.provider,
    SEARCH_DOCS_EMBEDDING_MODEL: model,
    SEARCH_DOCS_EMBEDDING_API_KEY: apiKey,
    SEARCH_DOCS_EMBEDDING_OPTIONS: JSON.stringify(provider),
    ISSUE183_PAUSE_AFTER: 'sections',
  };
  const child = spawn(python, [
    workerFile,
    `--embedding-url=${provider.baseUrl}`,
    `--embedding-dimension=${dimension}`,
    `--db-path=${indexPath}`,
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initModel', params: {} })}\n`);
  await waitForMarker(child, 'ISSUE183_PAUSED_AFTER:sections');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [code, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  assert.notEqual(code, 0);
  return indexPath;
}

async function crashMaintenanceAfterIncomplete(projectRoot) {
  const managementPath = path.join(projectRoot, '.search-docs/.search-docs-maintenance');
  const moduleUrl = pathToFileURL(path.join(repo, 'packages/db-engine/dist/index.js')).href;
  const script = `import { MaintenanceLock } from ${JSON.stringify(moduleUrl)};
const lock = new MaintenanceLock(process.argv[1]);
const lease = await lock.acquireExclusive();
await lease.markIncomplete();
process.stdout.write('EXCLUSIVE_AND_INCOMPLETE\\\\n');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, managementPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  await Promise.race([
    new Promise((resolve, reject) => {
      const check = () => {
        if (output.includes('EXCLUSIVE_AND_INCOMPLETE')) return resolve();
        child.once('exit', (code, signal) => reject(new Error(`lock holder exited early: ${code}/${signal}`)));
        child.stdout.once('data', check);
      };
      check();
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for incomplete marker')), 10000);
      timer.unref();
    }),
  ]);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  assert.equal((await readdir(managementPath)).includes('exclusive'), true);
  assert.equal((await readdir(managementPath)).includes('incomplete'), true);
  return managementPath;
}

async function hashTree(directory) {
  const entries = [];
  async function visit(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push([key, 'directory']);
        await visit(child, key);
      } else if (entry.isSymbolicLink()) {
        entries.push([key, `symlink:${await readFile(child).catch(() => '')}`]);
      } else {
        entries.push([key, createHash('sha256').update(await readFile(child)).digest('hex')]);
      }
    }
  }
  try { await visit(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return entries.sort((left, right) => left[0].localeCompare(right[0]));
}

async function listTables(indexPath) {
  const source = [
    'import json,sys,lancedb',
    'db=lancedb.connect(sys.argv[1])',
    'out={}',
    'for name in sorted(db.table_names()):',
    ' table=db.open_table(name)',
    ' out[name]={"rows":table.count_rows(),"indices":[getattr(i,"columns",None) for i in table.list_indices()]}',
    'print(json.dumps(out,sort_keys=True))',
  ].join('\n');
  const { stdout } = await execFile(python, ['-c', source, indexPath], {
    env: runtimeEnvironment,
    timeout: 30000,
  });
  return JSON.parse(stdout.trim());
}

async function manuallyRemoveOnlyKnownStaleExclusive(managementPath) {
  const users = await readdir(path.join(managementPath, 'users'));
  assert.deepEqual(users, [], 'fixture should have no shared users before exclusive removal');
  await rmdir(path.join(managementPath, 'exclusive'));
}

async function assertRecreateRecovery(projectRoot, workerFile) {
  await createProject(projectRoot);
  const indexPath = await crashAfterSections(projectRoot, workerFile);
  const tablesAtCrash = await listTables(indexPath);
  assert.deepEqual(Object.keys(tablesAtCrash).sort(), ['embedding_identity', 'sections']);

  const config = fixtureConfig(projectRoot);
  const beforeDiagnostic = await hashTree(indexPath);
  let diagnosticFailure = '';
  try { await quiet(() => diagnoseStrictConfig(config)); }
  catch (error) { diagnosticFailure = error.message; }
  const afterDiagnostic = await hashTree(indexPath);
  assert.match(diagnosticFailure, /writer_heartbeat/);
  assert.deepEqual(afterDiagnostic, beforeDiagnostic, 'read-only diagnosis changed the partial database');

  const managementPath = await crashMaintenanceAfterIncomplete(projectRoot);
  await manuallyRemoveOnlyKnownStaleExclusive(managementPath);
  const partialSnapshot = await hashTree(indexPath);
  await rm(path.join(projectRoot, 'source.md'));
  let missingSourceFailure = '';
  try { await runCli(projectRoot, 'index', 'recreate', '--confirm-isolated'); }
  catch (error) { missingSourceFailure = error.stderr || error.message; }
  assert(missingSourceFailure, 'recreate unexpectedly accepted a project with no current sources');
  assert.deepEqual(await hashTree(indexPath), partialSnapshot, 'failed preflight changed the partial index');
  assert.equal((await readdir(managementPath)).includes('incomplete'), true,
    'failed preflight should retain the pre-existing incomplete marker');

  await writeFile(path.join(projectRoot, 'source.md'), '# Source\n\nRecovery fixture.');
  await runCli(projectRoot, 'index', 'recreate', '--confirm-isolated');
  const recoveredTables = await listTables(indexPath);
  assert.deepEqual(Object.keys(recoveredTables).sort(), [
    'embedding_identity', 'index_requests', 'sections', 'writer_heartbeat',
  ]);
  const recoveredIndexes = Object.entries(recoveredTables)
    .flatMap(([table, state]) => state.indices.map(columns => `${table}:${columns.join(',')}`))
    .sort();
  assert.deepEqual(recoveredIndexes, [
    'index_requests:document_hash',
    'index_requests:document_path',
    'index_requests:status',
    'sections:document_hash',
    'sections:document_path',
    'sections:is_dirty',
  ]);
  assert.equal((await readdir(managementPath)).includes('incomplete'), false);
  assert.equal((await readdir(managementPath)).includes('exclusive'), false);
  await quiet(() => diagnoseStrictConfig(config));

  const engine = new (await import(pathToFileURL(path.join(repo, 'packages/db-engine/dist/index.js')).href)).DBEngine({
    dbPath: indexPath,
    embeddingUrl: provider.baseUrl,
    embeddingDimension: dimension,
    embeddingProvider: provider.provider,
    embeddingModel: model,
    embeddingOptions: provider,
  });
  await quiet(async () => {
    try {
      await engine.connect();
      assert((await engine.getSectionsByPath('source.md')).sections.length > 0,
        'recreated index did not contain the current source');
    } finally {
      await engine.disconnect();
    }
  });
  return {
    partialTablesAtCrash: Object.keys(tablesAtCrash),
    readOnlyDiagnosis: 'failed on missing writer_heartbeat; snapshot unchanged',
    missingSourceRecreate: 'failed before clearing partial index; snapshot unchanged',
    recreateAfterSourceRestored: 'success; complete tables/indexes and indexed source verified',
    incompleteClearedBySuccessfulRecreate: true,
  };
}

async function assertBackupRestore(projectRoot, backupRoot, workerFile) {
  await createProject(projectRoot);
  await runCli(projectRoot, 'index', 'recreate', '--confirm-isolated');
  const indexPath = path.join(projectRoot, '.search-docs/index');
  const documentsPath = path.join(projectRoot, '.search-docs/documents');
  const backupIndex = path.join(backupRoot, 'index');
  const backupDocuments = path.join(backupRoot, 'documents');
  await mkdir(backupRoot, { recursive: true });
  await cp(indexPath, backupIndex, { recursive: true });
  await cp(documentsPath, backupDocuments, { recursive: true });
  const healthyBackupHash = await hashTree(backupIndex);
  const healthyBackupDocumentsHash = await hashTree(backupDocuments);

  await rm(indexPath, { recursive: true });
  await crashAfterSections(projectRoot, workerFile);
  const managementPath = await crashMaintenanceAfterIncomplete(projectRoot);
  await manuallyRemoveOnlyKnownStaleExclusive(managementPath);
  const partialHash = await hashTree(indexPath);
  await rm(path.join(projectRoot, 'source.md'));
  let recreateFailure = '';
  try { await runCli(projectRoot, 'index', 'recreate', '--confirm-isolated'); }
  catch (error) { recreateFailure = error.stderr || error.message; }
  assert(recreateFailure, 'recreate unexpectedly succeeded without current source files');
  assert.deepEqual(await hashTree(indexPath), partialHash,
    'recreate should fail before clearing the partial database when no source is available');

  await rm(indexPath, { recursive: true });
  await rm(documentsPath, { recursive: true });
  await cp(backupIndex, indexPath, { recursive: true });
  await cp(backupDocuments, documentsPath, { recursive: true });
  assert.deepEqual(await hashTree(indexPath), healthyBackupHash, 'restored index differs from the known-good backup');
  assert.deepEqual(await hashTree(documentsPath), healthyBackupDocumentsHash,
    'restored documents differ from the known-good backup');
  await quiet(() => diagnoseStrictConfig(fixtureConfig(projectRoot)));

  const restoredLock = new MaintenanceLock(managementPath);
  let sharedRegistrationFailure = '';
  try { await restoredLock.acquireShared(); }
  catch (error) { sharedRegistrationFailure = error.message; }
  assert.match(sharedRegistrationFailure, /未完了/);
  assert.equal((await readdir(managementPath)).includes('incomplete'), true,
    'the experiment must not delete the maintenance incomplete marker');
  return {
    backupRestore: 'known-good index and documents restored byte-for-byte; strict DB diagnosis passed',
    currentSources: 'none; full recreate rejected before clearing the partial index',
    remainingBoundary: 'restored DB passes diagnosis, but stale incomplete still blocks shared registration',
  };
}

try {
  const workerFile = await instrumentWorker();
  const recreate = await assertRecreateRecovery(path.join(root, 'recreate-project'), workerFile);
  const backupRestore = await assertBackupRestore(
    path.join(root, 'backup-restore-project'),
    path.join(root, 'known-good-backup'),
    workerFile,
  );
  assert(embeddingRequests.length > 0, 'fake embedding endpoint did not serve any requests');
  console.log(JSON.stringify({
    scope: {
      database: 'real LanceDB in disposable temporary projects',
      embedding: 'loopback fake OpenAI-compatible endpoint; fixed nonzero vectors, no model inference',
      crash: 'SIGKILL after sections table creation and after exclusive+incomplete markers are durable',
      host: `${process.platform}; single host and local temporary filesystem`,
    },
    recreate,
    backupRestore,
    fakeEmbeddingRequests: embeddingRequests.length,
  }, null, 2));
} finally {
  await new Promise(resolve => embedding.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
