import { describe, expect, it, vi } from 'vitest';
import { executeIndexPurge } from '../index/purge.js';

describe('index purge', () => {
  it('確認がない場合は失敗する', async () => {
    const original = process.exitCode;
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.exitCode = 0;
      await executeIndexPurge({});
      expect(process.exitCode).toBe(1);
      expect(output).toHaveBeenCalled();
    } finally {
      process.exitCode = original;
      output.mockRestore();
    }
  });
});
