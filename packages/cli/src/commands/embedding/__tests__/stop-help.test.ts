import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliEntry = fileURLToPath(new URL('../../../../dist/index.js', import.meta.url));

describe('embedding stop --help', () => {
  it('explains when --port must be specified', () => {
    const result = spawnSync(process.execPath, [cliEntry, 'embedding', 'stop', '--help'], {
      encoding: 'utf8',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('管理記録が一意なら省略可');
    expect(result.stdout).toContain('複数/判別不能なら --port を指定');
    expect(result.stdout).toContain('PID 記録のない外部サーバを止める場合も --port が必要');
  });
});
