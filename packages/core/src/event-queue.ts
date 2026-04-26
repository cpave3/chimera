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
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined as unknown as T, done: true });
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
      const item = await this.next();
      if (item.done) return;
      yield item.value;
    }
  }
}
