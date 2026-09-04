/**
 * embedding stop コマンド
 */

import { isProcessAlive, getListeningProcess, killProcess } from '../../utils/process.js';
import {
  DEFAULT_EMBEDDING_PORT,
  isPortAvailable,
  readEmbeddingPidFile,
  removeEmbeddingPidFile,
  verifyEmbeddingStopped,
} from '../../utils/embedding.js';

export interface EmbeddingStopOptions {
  port?: string | number;
  force?: boolean;
}

export async function executeEmbeddingStop(options: EmbeddingStopOptions): Promise<void> {
  try {
    await stopEmbeddingServer(options);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exitCode = 1;
  }
}

function parsePort(value: string | number | undefined): number {
  const port = value === undefined ? DEFAULT_EMBEDDING_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

function describeOwner(owner: { pid: number; command?: string } | null): string {
  if (!owner) return 'owner PID could not be determined';
  return `PID ${owner.pid}${owner.command ? ` (${owner.command})` : ''}`;
}

function verificationMessage(verification: {
  processExited: boolean;
  portReleased: boolean;
  healthUnreachable: boolean;
}): string {
  return [
    `process ${verification.processExited ? 'exited' : 'still running'}`,
    `port ${verification.portReleased ? 'free' : 'still listening'}`,
    `health ${verification.healthUnreachable ? 'unreachable' : 'still responding'}`,
  ].join(', ');
}

export async function stopEmbeddingServer(options: EmbeddingStopOptions = {}): Promise<void> {
  const explicitPort = options.port !== undefined;
  const pidState = await readEmbeddingPidFile();

  if (pidState.error && !explicitPort) {
    throw new Error(
      `${pidState.error}. Specify --port <port> to stop an externally managed server, ` +
      'or remove the invalid PID file after confirming it is stale.',
    );
  }

  const filePort = pidState.value?.port;
  const port = parsePort(explicitPort ? options.port : filePort);
  const pidFileMatchesPort = !explicitPort || filePort === port;
  const owner = getListeningProcess(port);
  const filePid = pidState.value?.pid;
  const filePidAlive = filePid !== undefined && isProcessAlive(filePid);

  let targetPid: number | null = null;
  let managed = false;
  let external = false;

  if (pidFileMatchesPort && filePid !== undefined) {
    if (owner && owner.pid !== filePid) {
      if (!explicitPort) {
        throw new Error(
          `PID file points to PID ${filePid}, but port ${port} is owned by ${describeOwner(owner)}. ` +
          `Use --port ${port} only after confirming the external process is safe to stop.`,
        );
      }
      targetPid = owner.pid;
      external = true;
      console.warn(
        `Warning: PID file PID ${filePid} does not own port ${port}; targeting external ${describeOwner(owner)}.`,
      );
    } else if (filePidAlive) {
      targetPid = filePid;
      managed = true;
    } else if (owner && explicitPort) {
      targetPid = owner.pid;
      external = true;
      console.warn(
        `Warning: PID file is stale; stopping external process ${describeOwner(owner)} on port ${port}.`,
      );
    }
  } else if (explicitPort && owner) {
    // --portはPIDファイルに記録されたポートとは独立して外部サーバを指定できる。
    targetPid = owner.pid;
    external = true;
  }

  if (targetPid === null) {
    if (pidFileMatchesPort && pidState.exists && !filePidAlive) {
      const verification = await verifyEmbeddingStopped('127.0.0.1', port, null, 1000);
      if (!verification.portReleased || !verification.healthUnreachable) {
        throw new Error(
          `PID file is stale, but port ${port} is still in use (${verificationMessage(verification)}). ` +
          `Use --port ${port} to identify and stop the external process.`,
        );
      }
      await removeEmbeddingPidFile();
      console.log(`Embedding server is already stopped; removed stale PID file for port ${port}.`);
      return;
    }

    if (!explicitPort && !pidState.exists) {
      throw new Error(
        'No embedding server PID file found. Specify --port <port> to stop an externally managed server.',
      );
    }

    if (explicitPort && !owner) {
      const portAvailable = await isPortAvailable(port);
      if (portAvailable) {
        throw new Error(`No embedding server is listening on port ${port}.`);
      }
      throw new Error(
        `Port ${port} is in use, but its owner PID could not be determined. ` +
        'Stop it manually after confirming the process.',
      );
    }

    throw new Error(`No embedding server process found for port ${port}.`);
  }

  if (external) {
    console.warn(
      `Warning: stopping a process not managed by search-docs (${describeOwner(owner ?? { pid: targetPid })}).`,
    );
  }

  const signal = options.force ? 'SIGKILL' : 'SIGTERM';
  console.log(`Stopping embedding server (PID: ${targetPid}, ${signal})...`);
  await killProcess(targetPid, options.force ? 1000 : 5000, options.force === true);

  const verification = await verifyEmbeddingStopped('127.0.0.1', port, targetPid, options.force ? 3000 : 5000);
  if (!verification.processExited || !verification.portReleased || !verification.healthUnreachable) {
    throw new Error(`Stop verification failed for port ${port}: ${verificationMessage(verification)}.`);
  }

  if (managed || (pidFileMatchesPort && (!filePidAlive || filePid === targetPid))) {
    await removeEmbeddingPidFile();
  }

  console.log(`Embedding server stopped. ${verificationMessage(verification)}.`);
}
