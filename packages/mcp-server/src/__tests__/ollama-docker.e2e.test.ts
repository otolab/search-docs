import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

const image = process.env.ISSUE70_DOCKER_IMAGE;
const execFileAsync = promisify(execFile);
it.skipIf(!image)('indexes and searches through Docker MCP and real Ollama across restart', async () => {
  const project = await mkdtemp(join(tmpdir(), 'issue70-docker-'));
  let client: Client | undefined;
  try {
    await chmod(project, 0o755);
    await mkdir(join(project, '.search-docs'), { mode: 0o777 });
    await chmod(join(project, '.search-docs'), 0o777);
    await writeFile(join(project, '.search-docs.json'), JSON.stringify({
      files: { sources: ['**/*.md'] }, indexing: { vectorDimension: 256 }, worker: { interval: 200 },
    }));
    await writeFile(join(project, 'sample.md'), '# 宇宙犬\n\n宇宙犬は星の間を旅します。\n');
    const start = async () => {
      const transport = new StdioClientTransport({ command: 'docker', args: [
        'run', '--rm', '-i', '-v', `${project}:/workspace:ro`,
        '-v', `${project}/.search-docs:/workspace/.search-docs`,
        '-e', 'EMBEDDING_URL=http://host.docker.internal:12471',
        '-e', 'EMBEDDING_MODEL=qwen3-embedding:0.6b', image!,
      ], stderr: 'pipe' });
      transport.stderr?.on('data', () => {});
      const instance = new Client({ name: 'issue70-test', version: '1.0' });
      await instance.connect(transport);
      return instance;
    };
    client = await start();
    const search = async () => {
      const response = await client!.callTool({ name: 'search', arguments: { query: '宇宙犬' } });
      expect(JSON.stringify(response)).toContain('sample.md');
    };
    await vi.waitFor(search, { timeout: 90000, interval: 500 });
    await client.close();
    client = await start();
    await vi.waitFor(search, { timeout: 45000, interval: 500 });
  } finally {
    await client?.close();
    // Files created by the container's user need to be removable by the host.
    await execFileAsync('docker', ['run', '--rm', '--user', '0',
      '-v', `${project}/.search-docs:/cleanup`, '--entrypoint', 'chmod',
      image!, '-R', 'a+rwX', '/cleanup']);
    // Docker Desktop can release bind mounts shortly after the CLI exits.
    await vi.waitFor(() => rm(project, { recursive: true, force: true }),
      { timeout: 15000, interval: 500 });
  }
}, 180000);
