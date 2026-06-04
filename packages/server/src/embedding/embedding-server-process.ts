import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as http from 'http';

export interface EmbeddingServerOptions {
  embeddingUrl?: string;
  port?: number;
  runtime?: 'onnx' | 'torch';
  modelPath?: string;
  dimension?: number;
}

interface HealthResponse {
  status: string;
  model: string;
  vectorDimension: number;
}

export class EmbeddingServerProcess {
  private process: ChildProcess | null = null;
  private url: string | null = null;
  private external = false;

  constructor(private options: EmbeddingServerOptions) {}

  async start(): Promise<string> {
    const port = this.options.port ?? 24281;

    // 1. 明示的なURL指定
    if (this.options.embeddingUrl) {
      if (await this.healthCheck(this.options.embeddingUrl)) {
        this.url = this.options.embeddingUrl;
        this.external = true;
        console.log(`[EmbeddingServer] Using external server: ${this.url}`);
        return this.url;
      }
      console.warn(`[EmbeddingServer] Configured URL ${this.options.embeddingUrl} not responding, trying alternatives...`);
    }

    // 2. Docker network (compose service)
    const dockerServiceUrl = `http://search-docs-embedding:${port}`;
    if (await this.healthCheck(dockerServiceUrl)) {
      this.url = dockerServiceUrl;
      this.external = true;
      console.log(`[EmbeddingServer] Using Docker service: ${this.url}`);
      return this.url;
    }

    // 3. Host-side server (from Docker container)
    const hostUrl = `http://host.docker.internal:${port}`;
    if (await this.healthCheck(hostUrl)) {
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
    if (this.process) {
      console.log('[EmbeddingServer] Stopping local server...');
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);
        this.process!.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.process = null;
    }
  }

  /**
   * 即座に停止する（シグナルハンドラ用）
   * 子プロセスは親プロセス終了時にOSが回収するため、終了待ちは不要。
   */
  shutdown(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
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

    this.process = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        console.log(`[embedding-server] ${line}`);
      }
    });

    this.process.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`[EmbeddingServer] Process exited with code ${code}`);
      } else if (signal) {
        console.log(`[EmbeddingServer] Process killed by signal ${signal}`);
      }
    });

    this.url = `http://localhost:${port}`;
    await this.waitForReady(this.url, 30);
    console.log(`[EmbeddingServer] Local server ready at ${this.url}`);
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
              if (json.status === 'ok') {
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

  private async waitForReady(url: string, maxWaitSeconds: number): Promise<void> {
    const startTime = Date.now();
    const maxWaitMs = maxWaitSeconds * 1000;

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.healthCheck(url)) {
        return;
      }

      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(`[EmbeddingServer] Process exited with code ${this.process.exitCode} before becoming ready`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`[EmbeddingServer] Did not become ready within ${maxWaitSeconds}s at ${url}`);
  }
}
