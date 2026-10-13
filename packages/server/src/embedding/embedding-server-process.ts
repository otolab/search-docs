import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import {
  EMBEDDING_READY_TIMEOUT_ENV,
  getEmbeddingReadyTimeoutMs,
} from '@search-docs/common';

export interface EmbeddingServerOptions {
  embeddingUrl?: string;
  port?: number;
  runtime?: 'onnx' | 'torch';
  modelPath?: string;
  dimension?: number;
  readyTimeoutMs?: number;
}

interface HealthResponse {
  status: string;
  model: string;
  vectorDimension: number;
  ready?: boolean;
}

export class EmbeddingServerProcess {
  private process: ChildProcess | null = null;
  private processError: Error | null = null;
  private stopPromise: Promise<void> | null = null;
  private url: string | null = null;
  private external = false;

  constructor(private options: EmbeddingServerOptions) {}

  async start(): Promise<string> {
    const port = this.options.port ?? 24281;

    // 1. 明示的なURL指定
    if (this.options.embeddingUrl) {
      if (await this.externalServerReady(this.options.embeddingUrl)) {
        this.url = this.options.embeddingUrl;
        this.external = true;
        console.log(`[EmbeddingServer] Using external server: ${this.url}`);
        return this.url;
      }
      console.warn(`[EmbeddingServer] Configured URL ${this.options.embeddingUrl} not responding, trying alternatives...`);
    }

    // 2. Docker network (compose service)
    const dockerServiceUrl = `http://search-docs-embedding:${port}`;
    if (await this.externalServerReady(dockerServiceUrl)) {
      this.url = dockerServiceUrl;
      this.external = true;
      console.log(`[EmbeddingServer] Using Docker service: ${this.url}`);
      return this.url;
    }

    // 3. Host-side server (from Docker container)
    const hostUrl = `http://host.docker.internal:${port}`;
    if (await this.externalServerReady(hostUrl)) {
      this.url = hostUrl;
      this.external = true;
      console.log(`[EmbeddingServer] Using host server: ${this.url}`);
      return this.url;
    }

    // 4. ローカル起動
    console.log('[EmbeddingServer] No external server found, starting local...');
    await this.startLocal(port);
    return this.url!;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.process;
    if (!child) return;

    console.log('[EmbeddingServer] Stopping local server...');
    this.stopPromise = this.stopChildProcess(child).finally(() => {
      this.stopPromise = null;
    });
    await this.stopPromise;
  }

  /**
   * シグナルハンドラなど同期 callback から停止処理を始める。
   */
  shutdown(): void {
    void this.stop().catch((error: unknown) => {
      console.error('[EmbeddingServer] Failed to stop local server:', error);
    });
  }

  getUrl(): string {
    if (!this.url) {
      throw new Error('[EmbeddingServer] Not started yet');
    }
    return this.url;
  }

  isExternal(): boolean {
    return this.external;
  }

  private async startLocal(port: number): Promise<void> {
    const isDocker = process.env.IS_DOCKER === 'true';
    const scriptPath = this.resolveScriptPath(isDocker);
    const cmd = isDocker ? 'python' : 'uv';
    const args = this.buildArgs(isDocker, scriptPath, port);
    const readyTimeoutMs = getEmbeddingReadyTimeoutMs(this.options.readyTimeoutMs);

    this.process = spawn(cmd, args, {
      // uv may launch Python as a child. A dedicated process group lets cleanup
      // reap both processes without affecting the parent server.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    const child = this.process;
    this.processError = null;
    child.on('error', (error) => {
      this.processError = error;
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        console.log(`[embedding-server] ${line}`);
      }
    });

    child.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`[EmbeddingServer] Process exited with code ${code}`);
      } else if (signal) {
        console.log(`[EmbeddingServer] Process killed by signal ${signal}`);
      }
    });

    this.url = `http://localhost:${port}`;
    try {
      await this.waitForReady(this.url, readyTimeoutMs, child);
    } catch (error) {
      try {
        await this.stopChildProcess(child);
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Failed to reap the local embedding process: ${message}`,
          { cause: error },
        );
      }
      throw error;
    }
    console.log(`[EmbeddingServer] Local server ready at ${this.url}`);
  }

  private async stopChildProcess(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid) {
      if (this.process === child) this.process = null;
      return;
    }

    await this.signalProcessTree(child, 'SIGTERM');
    if (!(await this.waitForProcessTreeExit(child, 5000))) {
      await this.signalProcessTree(child, 'SIGKILL');
      if (!(await this.waitForProcessTreeExit(child, 1000))) {
        throw new Error(`Local embedding process tree (PID ${pid}) did not exit`);
      }
    }

    if (this.process === child) this.process = null;
  }

  private async signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    const pid = child.pid;
    if (!pid) return;

    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const args = ['/PID', String(pid), '/T'];
        if (signal === 'SIGKILL') args.push('/F');
        const killer = spawn('taskkill', args, { stdio: 'ignore' });
        killer.once('error', reject);
        killer.once('close', (code) => {
          if (code === 0 || code === 128) resolve();
          else reject(new Error(`taskkill failed with code ${code}`));
        });
      });
      return;
    }

    try {
      // Local children are spawned detached, so their PID is also the process
      // group ID. Signal the whole group in case uv has already exited.
      process.kill(-pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
        return;
      }
      throw error;
    }
  }

  private async waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const childExited = child.exitCode !== null || child.signalCode !== null || this.processError !== null;
      let groupAlive = false;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 0);
          groupAlive = true;
        } catch (error) {
          groupAlive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }

      if (childExited && !groupAlive) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  private resolveScriptPath(isDocker: boolean): string {
    if (isDocker) {
      return process.env.SEARCH_DOCS_DOCKER_PYTHON_DIR
        ? `${process.env.SEARCH_DOCS_DOCKER_PYTHON_DIR}/embedding_server.py`
        : '/app/python/embedding_server.py';
    }
    // 非Docker: db-engineパッケージ内のスクリプト
    // packages/server → packages/db-engine
    const serverPackageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const dbEngineRoot = path.resolve(serverPackageRoot, '../db-engine');
    return path.join(dbEngineRoot, 'src/python/embedding_server.py');
  }

  private buildArgs(isDocker: boolean, scriptPath: string, port: number): string[] {
    const args: string[] = [];

    if (!isDocker) {
      const serverPackageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
      const dbEngineRoot = path.resolve(serverPackageRoot, '../db-engine');
      args.push('--project', dbEngineRoot, 'run', 'python');
    }

    args.push(scriptPath);
    args.push(`--port=${port}`);

    if (this.options.runtime) {
      args.push(`--runtime=${this.options.runtime}`);
    }
    if (this.options.modelPath) {
      args.push(`--model-path=${this.options.modelPath}`);
    }
    if (this.options.dimension) {
      args.push(`--dimension=${this.options.dimension}`);
    }

    return args;
  }

  private healthCheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const healthUrl = `${url}/health`;
      const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
        if (res.statusCode === 200) {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as HealthResponse;
              if (json.status === 'ok' || json.status === 'degraded') {
                resolve(true);
                return;
              }
            } catch { /* ignore */ }
            resolve(false);
          });
        } else {
          res.resume();
          resolve(false);
        }
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * 外部サーバはlivenessだけでなくreadinessも確認してから採用する。
   * /readyを持たない旧サーバはreadinessCheck内で/healthへfallbackする。
   */
  private async externalServerReady(url: string): Promise<boolean> {
    if (!(await this.healthCheck(url))) return false;
    if (await this.readinessCheck(url)) return true;
    console.warn(`[EmbeddingServer] External server ${url} is live but not ready; it will not be used.`);
    return false;
  }

  private async waitForReady(
    url: string,
    maxWaitMs: number,
    child: ChildProcess,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      this.assertProcessCanBecomeReady(child);
      const ready = await this.readinessCheck(url);
      this.assertProcessCanBecomeReady(child);
      if (ready) return;

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      `[EmbeddingServer] Did not become ready within ${maxWaitMs}ms at ${url}. ` +
      `Increase --ready-timeout or ${EMBEDDING_READY_TIMEOUT_ENV} if the first model download is still running.`,
    );
  }

  private assertProcessCanBecomeReady(child: ChildProcess): void {
    if (this.processError) {
      throw new Error(
        `[EmbeddingServer] Failed to start local process: ${this.processError.message}`,
        { cause: this.processError },
      );
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      const result = child.signalCode
        ? `signal ${child.signalCode}`
        : `code ${child.exitCode}`;
      throw new Error(`[EmbeddingServer] Process exited with ${result} before becoming ready`);
    }
  }

  /**
   * /readyを優先し、旧Embeddingサーバでは/healthへフォールバックする。
   */
  private readinessCheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const readyUrl = `${url}/ready`;
      const req = http.get(readyUrl, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 404) {
            void this.legacyReadinessCheck(url).then(resolve);
            return;
          }
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const json = JSON.parse(data) as { ready?: boolean };
            resolve(json.ready === true);
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private legacyReadinessCheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${url}/health`, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const json = JSON.parse(data) as HealthResponse;
            resolve(json.ready ?? json.status === 'ok');
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}
