import type { SearchDocsService } from '@search-docs/types';

/** 保守中の新規要求を拒否し、受理済み要求の完了を待つ。 */
export class RequestGate {
  private accepting = true;
  private active = 0;
  private waiters: Array<() => void> = [];

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('保守中のため要求を受け付けられません');
    this.active++;
    try { return await action(); } finally {
      this.active--;
      if (this.active === 0) for (const resolve of this.waiters.splice(0)) resolve();
    }
  }

  async closeAndDrain(): Promise<void> {
    this.accepting = false;
    if (this.active) await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  reopen(): void { this.accepting = true; }
}
/** サービスを呼ぶ全公開メソッドの寿命を登録する。 */
export function gateService(service: SearchDocsService, gate: RequestGate): SearchDocsService {
  return {
    search: request => gate.run(() => service.search(request)),
    getDocument: request => gate.run(() => service.getDocument(request)),
    getOutline: request => gate.run(() => service.getOutline(request)),
    getStatus: () => gate.run(() => service.getStatus()),
  };
}
