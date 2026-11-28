/**
 * embedding stop コマンド
 */

import { isProcessAlive, getListeningProcess, killProcess } from '../../utils/process.js';
import {
  DEFAULT_EMBEDDING_PORT,
  embeddingPidPathForPort,
  isPortAvailable,
  readEmbeddingPidFileForPort,
  readUniqueEmbeddingPidFile,
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
  const requestedPort = explicitPort ? parsePort(options.port) : undefined;
  const selection = explicitPort
    ? { state: await readEmbeddingPidFileForPort(requestedPort!), port: requestedPort, ambiguousPorts: [] }
    : await readUniqueEmbeddingPidFile();
  if (selection.ambiguousPorts.length > 0) {
    const ports = selection.ambiguousPorts.filter((value) => value > 0);
    throw new Error(
      `Multiple or invalid embedding PID files make the target ambiguous` +
      `${ports.length ? ` (ports: ${ports.join(', ')})` : ''}. Specify --port <port>.`,
    );
  }
  const pidState = selection.state;
  if (pidState.error && !explicitPort) {
    throw new Error(
      `${pidState.error}. Specify --port <port> to identify the target, or inspect the PID file manually.`,
    );
  }
  const port = parsePort(requestedPort ?? selection.port ?? pidState.value?.port);
  const filePort = pidState.value?.port ?? pidState.portHint;
  const pidFileMatchesPort = filePort === port;
  const owner = getListeningProcess(port);
  const filePid = pidState.value?.pid;
  const filePidAlive = filePid !== undefined && isProcessAlive(filePid);
  const launchId = pidState.value?.launchId;

  let targetPid: number | null = null;
  let managed = false;
  let external = false;

  if (pidFileMatchesPort && filePid !== undefined) {
    if (!filePidAlive) {
      if (owner && !explicitPort) {
        throw new Error(
          `PID file is stale, but port ${port} is owned by ${describeOwner(owner)}. ` +
          `Use --port ${port} only after confirming the external process is safe to stop.`,
        );
      }
      if (owner && explicitPort) {
        targetPid = owner.pid;
        external = true;
        console.warn(
          `Warning: PID file is stale; explicit --port targets external ${describeOwner(owner)}.`,
        );
      }
    } else {
      if (!owner) {
        throw new Error(
          `Cannot safely stop PID ${filePid}: the LISTEN owner of port ${port} could not be determined. ` +
          `Refusing to kill a possibly reused PID. Retry with --port ${port} when the owner can be identified; ` +
          '--force does not bypass this safety check.',
        );
      }
      const identityMatches = Boolean(
        owner.pid === filePid &&
        launchId &&
        owner.command?.includes(`--search-docs-startup-id=${launchId}`),
      );
      if (identityMatches) {
        targetPid = filePid;
        managed = true;
      } else if (!explicitPort) {
        const reason = !launchId
          ? 'the PID file has no launch identity (legacy records cannot prove ownership)'
          : owner.pid !== filePid
            ? `port ${port} is owned by ${describeOwner(owner)}`
            : `the current process identity for PID ${filePid} does not match the PID file`;
        throw new Error(
          `Cannot safely stop PID ${filePid}: ${reason}. ` +
          `Refusing to kill it. Specify --port ${port} only after confirming the target.`,
        );
      } else {
        targetPid = owner.pid;
        external = true;
        console.warn(
          `Warning: ownership could not be verified from PID file PID ${filePid}; ` +
          `explicit --port targets ${describeOwner(owner)}.`,
        );
      }
    }
  } else if (explicitPort && owner) {
    // --portはPIDファイルに記録されたポートとは独立して外部サーバを指定できる。
    targetPid = owner.pid;
    external = true;
  }

  if (targetPid === null) {
    if (pidFileMatchesPort && pidState.exists && !pidState.error && !filePidAlive) {
      const verification = await verifyEmbeddingStopped('127.0.0.1', port, null, 1000);
      if (!verification.portReleased || !verification.healthUnreachable) {
        throw new Error(
          `PID file is stale, but port ${port} is still in use (${verificationMessage(verification)}). ` +
          `Use --port ${port} to identify and stop the external process.`,
        );
      }
      await removeEmbeddingPidFile(pidState.path ?? embeddingPidPathForPort(port));
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

  // Recheck immediately before signaling. This narrows the PID-reuse/owner
  // replacement window, but cannot make process lookup and signal atomic.
  const currentOwner = getListeningProcess(port);
  if (currentOwner?.pid !== targetPid) {
    throw new Error(
      `Port ${port} is no longer owned by PID ${targetPid}; refusing to signal a changed listener.`,
    );
  }
  if (managed && (!launchId || !currentOwner.command?.includes(`--search-docs-startup-id=${launchId}`))) {
    throw new Error(
      `The process identity for PID ${targetPid} changed before stop; refusing to signal it.`,
    );
  }
  if (!isProcessAlive(targetPid)) {
    throw new Error(`Process ${targetPid} exited before it could be stopped; no signal was sent.`);
  }

  const signal = options.force ? 'SIGKILL' : 'SIGTERM';
  console.log(`Stopping embedding server (PID: ${targetPid}, ${signal})...`);
  await killProcess(targetPid, options.force ? 1000 : 5000, options.force === true);

  const verification = await verifyEmbeddingStopped('127.0.0.1', port, targetPid, options.force ? 3000 : 5000);
  if (!verification.processExited || !verification.portReleased || !verification.healthUnreachable) {
    throw new Error(`Stop verification failed for port ${port}: ${verificationMessage(verification)}.`);
  }

  if (managed || (pidFileMatchesPort && (!filePidAlive || filePid === targetPid))) {
    await removeEmbeddingPidFile(pidState.path ?? embeddingPidPathForPort(port));
  }

  console.log(`Embedding server stopped. ${verificationMessage(verification)}.`);
}
