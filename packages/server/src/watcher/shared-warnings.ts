import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Status files are keyed by heartbeat writer id, so an expired writer cannot overwrite its successor. */
export class SharedWarnings {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly writerId: string) {}

  private file(writerId: string): string {
    const id = createHash('sha256').update(writerId).digest('hex');
    return path.join(this.directory, `.search-docs-warnings-${id}.json`);
  }

  publish(warnings: string[]): void {
    const snapshot = [...warnings];
    this.pending = this.pending.then(async () => {
      const target = this.file(this.writerId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(this.directory, { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }).catch(async error => {
      console.error('[WatcherProcess] Failed to publish warnings:', error);
      // Do not leave an earlier, apparently healthy snapshot when publication fails.
      await fs.rm(this.file(this.writerId), { force: true }).catch(removeError => {
        console.error('[WatcherProcess] Failed to invalidate warning status:', removeError);
      });
    });
  }

  async read(writerId: string): Promise<string[]> {
    const value: unknown = JSON.parse(await fs.readFile(this.file(writerId), 'utf8'));
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('invalid warning status');
    return value;
  }

  async close(): Promise<void> {
    await this.pending;
    await fs.rm(this.file(this.writerId), { force: true });
  }
}
