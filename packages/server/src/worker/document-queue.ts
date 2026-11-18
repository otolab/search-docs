/** 同一パスの書き込みを到着順に実行する。異なるパスは互いに待たない。 */
export class DocumentQueue {
  private pending = new Map<string, Promise<void>>();

  async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.pending.set(path, current);
    await previous;
    try {
      return await operation();
    } finally {
      if (this.pending.get(path) === current) this.pending.delete(path);
      release();
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending.values());
    }
  }
}
