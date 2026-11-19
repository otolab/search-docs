import { describe, expect, it, vi } from 'vitest';
import { registerDiagnoseDuplicatesTool } from '../diagnose-duplicates.js';
import type { ToolRegistrationContext } from '../types.js';

describe('diagnose_duplicates', () => {
  it('走査の不完全さを表示し、正常とは表示しない', async () => {
    let handler!: () => Promise<{ content: Array<{ text: string }> }>;
    const db = { diagnoseDuplicateSections: vi.fn().mockResolvedValue({ version: 3, complete: false, rowsRead: 50001, bytesRead: 100, candidates: [], ambiguous: 0, omitted: 0 }) };
    const context = {
      server: { registerTool: (_name: string, _schema: unknown, fn: typeof handler) => { handler = fn; return {}; } },
      systemState: { state: 'RUNNING' }, getDbEngine: () => db,
    } as unknown as ToolRegistrationContext;
    registerDiagnoseDuplicatesTool(context);
    const result = await handler();
    expect(result.content[0].text).toContain('不完全');
    expect(result.content[0].text).toContain('判定できません');
  });

  it('DB エラーでも不完全と表示する', async () => {
    let handler!: () => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const context = {
      server: { registerTool: (_name: string, _schema: unknown, fn: typeof handler) => { handler = fn; return {}; } },
      systemState: { state: 'RUNNING' },
      getDbEngine: () => ({ diagnoseDuplicateSections: vi.fn().mockRejectedValue(new Error('snapshot unavailable')) }),
    } as unknown as ToolRegistrationContext;
    registerDiagnoseDuplicatesTool(context);
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('不完全');
  });
});
