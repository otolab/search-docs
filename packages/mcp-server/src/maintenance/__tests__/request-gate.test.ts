import { describe, expect, it, vi } from 'vitest';
import type { SearchDocsService } from '@search-docs/types';
import { gateService, RequestGate } from '../request-gate.js';

describe('保守中の要求制御', () => {
  it('既存要求の完了を待ち、新規要求は拒否し、再開後に受け付ける', async () => {
    const gate = new RequestGate();
    let finish!: () => void;
    const active = gate.run(() => new Promise<void>(resolve => { finish = resolve; }));
    let drained = false;
    const closing = gate.closeAndDrain().then(() => { drained = true; });
    await expect(gate.run(async () => {})).rejects.toThrow(/保守中/);
    expect(drained).toBe(false);
    finish();
    await Promise.all([active, closing]);
    expect(drained).toBe(true);
    gate.reopen();
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
  it('受理済み要求が失敗しても停止待ちは完了する', async () => {
    const gate = new RequestGate();
    let fail!: (error: Error) => void;
    const active = gate.run(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const closing = gate.closeAndDrain();
    fail(new Error('failed'));
    await expect(active).rejects.toThrow('failed');
    await expect(closing).resolves.toBeUndefined();
  });
  it('サービス参照を取得済みでも、保守開始後の要求を拒否する', async () => {
    const gate = new RequestGate();
    const search = vi.fn(async () => ({ results: [], total: 0, took: 0 }));
    const service = gateService({ search } as unknown as SearchDocsService, gate);
    await gate.closeAndDrain();
    await expect(service.search({ query: 'test' })).rejects.toThrow(/保守中/);
    expect(search).not.toHaveBeenCalled();
    gate.reopen();
    await service.search({ query: 'test' });
    expect(search).toHaveBeenCalledOnce();
  });
});
