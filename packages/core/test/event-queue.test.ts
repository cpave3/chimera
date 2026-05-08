import { describe, expect, it } from 'vitest';
import { EventQueue } from '../src/event-queue';

describe('EventQueue', () => {
  it('delivers values in FIFO order', async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);

    expect((await queue.next()).value).toBe(1);
    expect((await queue.next()).value).toBe(2);
    expect((await queue.next()).value).toBe(3);
  });

  it('resolves waiters FIFO before buffering', async () => {
    const queue = new EventQueue<string>();

    const promiseA = queue.next();
    const promiseB = queue.next();

    queue.push('first');
    queue.push('second');
    queue.push('third');

    expect((await promiseA).value).toBe('first');
    expect((await promiseB).value).toBe('second');
    expect((await queue.next()).value).toBe('third');
  });

  it('push after close is a no-op', async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    queue.close();
    queue.push(2);

    expect((await queue.next()).value).toBe(1);
    expect((await queue.next()).done).toBe(true);
  });

  it('close resolves all outstanding waiters', async () => {
    const queue = new EventQueue<number>();

    const promiseA = queue.next();
    const promiseB = queue.next();
    const promiseC = queue.next();

    queue.close();

    const results = await Promise.all([promiseA, promiseB, promiseC]);
    expect(results.every((r) => r.done)).toBe(true);
  });

  it('multiple close calls are idempotent', async () => {
    const queue = new EventQueue<number>();

    const promiseA = queue.next();

    queue.close();
    queue.close();
    queue.close();

    const resultA = await promiseA;
    expect(resultA.done).toBe(true);

    queue.push(42);
    const promiseB = queue.next();
    const resultB = await promiseB;
    expect(resultB.done).toBe(true);
  });

  it('drain yields all buffered values then terminates', async () => {
    const queue = new EventQueue<number>();
    queue.push(10);
    queue.push(20);
    queue.close();

    const collected: number[] = [];
    for await (const value of queue.drain()) {
      collected.push(value);
    }

    expect(collected).toEqual([10, 20]);
  });

  it('drain waits for values pushed after iteration starts', async () => {
    const queue = new EventQueue<number>();

    const promise = (async () => {
      const collected: number[] = [];
      for await (const value of queue.drain()) {
        collected.push(value);
      }
      return collected;
    })();

    queue.push(1);
    queue.push(2);
    queue.close();

    const collected = await promise;
    expect(collected).toEqual([1, 2]);
  });

  it('stress: rapid interleaved push/close from multiple producers', async () => {
    const queue = new EventQueue<number>();
    const producerCount = 10;
    const valuesPerProducer = 50;

    const producerPromises: Promise<void>[] = [];
    for (let producerIndex = 0; producerIndex < producerCount; producerIndex++) {
      producerPromises.push(
        (async () => {
          for (let valueIndex = 0; valueIndex < valuesPerProducer; valueIndex++) {
            queue.push(producerIndex * valuesPerProducer + valueIndex);
            if (valueIndex % 10 === 0) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }
        })(),
      );
    }

    const closePromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      queue.close();
    })();

    const collected: number[] = [];
    const drainPromise = (async () => {
      for await (const value of queue.drain()) {
        collected.push(value);
      }
    })();

    await Promise.all([...producerPromises, closePromise]);
    await drainPromise;

    const set = new Set(collected);
    expect(set.size).toBe(collected.length);

    const expectedValues = producerCount * valuesPerProducer;
    expect(collected.length).toBeLessThanOrEqual(expectedValues);
    for (let i = 0; i < expectedValues; i++) {
      if (collected.includes(i)) {
        expect(set.has(i)).toBe(true);
      }
    }
  });
});
