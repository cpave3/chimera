/**
 * Async event queue. Producers push events; consumers iterate via `drain()`.
 * Multiple producers, single consumer. Close() signals end-of-stream.
 */
export class EventQueue<T> {
  private buffer: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) {
      r({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers) {
      r({ value: undefined as unknown as T, done: true });
    }
    this.resolvers = [];
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  async *drain(): AsyncIterable<T> {
    while (true) {
      const r = await this.next();
      if (r.done) return;
      yield r.value;
    }
  }
}
