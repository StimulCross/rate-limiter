import { describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '../../../src/errors/rate-limit.error.js';
import { InMemoryStateStore } from '../../../src/runtime/in-memory-state-store.js';

interface TestClock {
	now: () => number;
}

describe('InMemoryStateStore', () => {
	const createClock = (startMs = 0): { clock: TestClock; advanceBy: (ms: number) => void } => {
		let nowMs = startMs;

		return {
			clock: { now: () => nowMs },
			advanceBy: (ms: number) => {
				nowMs += ms;
			},
		};
	};

	describe('CRUD operations', () => {
		it('should return null for missing keys', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await expect(store.get('missing')).resolves.toBeNull();

			await store.destroy();
		});

		it('should store and retrieve the last set value', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('k', 'v1');
			await store.set('k', 'v2');

			await expect(store.get('k')).resolves.toBe('v2');

			await store.destroy();
		});

		it('should delete keys properly', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('k', 'v');
			await store.delete('k');

			await expect(store.get('k')).resolves.toBeNull();

			await store.destroy();
		});
	});

	describe('TTL semantics', () => {
		it('should expire a value strictly after ttlMs has passed', async () => {
			const { clock, advanceBy } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('k', 'v', 100);

			await expect(store.get('k')).resolves.toBe('v');

			advanceBy(100);

			await expect(store.get('k')).resolves.toBeNull();

			await store.destroy();
		});

		it('should never expire when ttlMs is not provided', async () => {
			const { clock, advanceBy } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('k', 'v');

			advanceBy(10_000_000);

			await expect(store.get('k')).resolves.toBe('v');

			await store.destroy();
		});

		it('should delete key immediately if ttlMs is 0, even if overwriting an existing key', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('k', 'old_value');
			await store.set('k', 'new_value', 0);

			await expect(store.get('k')).resolves.toBeNull();

			await store.destroy();
		});

		it('should delete key immediately if ttlMs is negative', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('k', 'v', -50);

			await expect(store.get('k')).resolves.toBeNull();

			await store.destroy();
		});
	});

	describe('Periodic Cleanup', () => {
		it('should physically remove expired entries on cleanup interval tick', async () => {
			vi.useFakeTimers();

			const { clock, advanceBy } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('k', 'v', 10);

			advanceBy(10);

			await vi.advanceTimersByTimeAsync(60_000);

			// @ts-ignore private field access
			expect(store._state.has('k')).toBe(false);

			await store.destroy();
			vi.useRealTimers();
		});
	});

	describe('Mutex (Locks)', () => {
		it('should allow acquireLock immediately when no lock is held', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await expect(store.acquireLock('k')).resolves.toBeUndefined();

			await store.releaseLock('k');
			await store.destroy();
		});

		it('should not block locks for entirely different keys', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.acquireLock('k1');

			let acquiredK2 = false;
			await store.acquireLock('k2').then(() => (acquiredK2 = true));

			expect(acquiredK2).toBe(true);

			await store.releaseLock('k2');
			await store.releaseLock('k1');
			await store.destroy();
		});

		it('should serialize acquireLock calls and unblock them in strict FIFO order', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			const executionOrder: number[] = [];

			await store.acquireLock('k');
			executionOrder.push(1);

			const waiter1 = store.acquireLock('k').then(() => executionOrder.push(2));
			const waiter2 = store.acquireLock('k').then(() => executionOrder.push(3));

			await Promise.resolve();
			expect(executionOrder).toEqual([1]);

			await store.releaseLock('k');
			await Promise.resolve();
			await Promise.resolve();
			expect(executionOrder).toEqual([1, 2]);

			await store.releaseLock('k');
			await waiter1;
			await waiter2;
			expect(executionOrder).toEqual([1, 2, 3]);

			await store.releaseLock('k');
			await store.destroy();
		});
	});

	describe('Clear and Destroy logic', () => {
		it('should clear stored values on clear()', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.set('a', '1');
			await store.set('b', '2');

			await store.clear();

			await expect(store.get('a')).resolves.toBeNull();
			await expect(store.get('b')).resolves.toBeNull();

			await store.destroy();
		});

		it('should stop the cleanup timer on destroy()', async () => {
			vi.useFakeTimers();

			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

			await store.destroy();

			expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

			clearIntervalSpy.mockRestore();
			vi.useRealTimers();
		});

		it('should reject all waiting locks with RateLimitError when cleared', async () => {
			const { clock } = createClock(1000);
			const store = new InMemoryStateStore<string>(clock);

			await store.acquireLock('k');

			const waiter1 = store.acquireLock('k');
			const waiter2 = store.acquireLock('k');

			await Promise.resolve();

			await store.clear();

			await expect(waiter1).rejects.toThrowError(RateLimitError);
			await expect(waiter2).rejects.toThrowError(RateLimitError);

			await store.destroy();
		});
	});
});
