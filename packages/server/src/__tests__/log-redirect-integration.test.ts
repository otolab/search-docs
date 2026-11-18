import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

async function runFixture(logPath: string, mode = 'warnings') {
  const child = spawn(process.execPath, [join(process.cwd(), 'src/__tests__/fixtures/issue150-log-redirect.mjs'), logPath, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

describe('non-TTY writer log redirection', () => {
  it('uses the actual MCP entry point and its default or overridden log path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-log-'));
    try {
      for (const override of [false, true]) {
        const project = join(root, override ? 'custom' : 'default');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(project);
        const log = override ? join(root, 'custom.log') : join(project, '.search-docs', 'server.log');
        const env = { ...process.env, DEBUG: '1' };
        if (override) env.SEARCH_DOCS_LOG_PATH = log;
        else delete env.SEARCH_DOCS_LOG_PATH;
        const entry = join(process.cwd(), '../mcp-server/dist/server.js');
        const child = spawn(process.execPath, [entry, '--project-dir', project], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
        try {
          await vi.waitFor(async () => {
            expect(await readFile(log, 'utf8')).toContain(`Working directory: ${project}`);
          }, { timeout: 10000 });
          expect(stderr).not.toContain(`Working directory: ${project}`);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await new Promise<void>(resolve => child.once('close', () => resolve()));
          }
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it('writes omitted and long warnings in full to the configured file, not stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-log-'));
    try {
      const log = join(root, '.search-docs', 'server.log');
      const result = await runFixture(log);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('candidate-25');
      expect(result.stdout).not.toContain('candidate-25');
      expect(await readFile(log, 'utf8')).toContain(`candidate-25: ${'x'.repeat(600)}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains only three rotated files and does not promise logs when the path is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-log-rotation-'));
    try {
      const log = join(root, 'server.log');
      expect((await runFixture(log, 'rotate')).code).toBe(0);
      expect(await readFile(`${log}.3`, 'utf8')).toContain('rotation-2');
      await expect(readFile(`${log}.4`, 'utf8')).rejects.toThrow();
      const blocker = join(root, 'not-a-directory');
      await writeFile(blocker, 'x');
      expect((await runFixture(join(blocker, 'server.log'))).code).not.toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
