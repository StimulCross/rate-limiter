import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Clock, RateLimiterDestroyedError, RateLimitErrorCode } from '../../../src/index.js';
import { GenericCellLimiter, type GenericCellState } from '../../../src/limiters/generic-cell/index.js';
import { InMemoryStateStore } from '../../../src/runtime/in-memory-state-store.js';

describe('GenericCellLimiter (Integration)', () => {
	let clock: Clock;
	let store: InMemoryStateStore<GenericCellState>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);

		clock = { now: () => Date.now() };
		store = new InMemoryStateStore(clock);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	describe('Reject mode (immediate decisions)', () => {
		it('should allow requests within the burst limit immediately', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'reject',
				burst: 2,
				intervalMs: 100,
				clock,
				store,
			});

			const res1 = await limiter.run(async () => 'A');
			const res2 = await limiter.run(async () => 'B');

			expect(res1).toBe('A');
			expect(res2).toBe('B');
		});

		it('should reject requests that exceed the burst limit if behavior is "reject"', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'reject',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			void limiter.run(() => 'A');

			const promise = limiter.run(() => 'B');
			await expect(promise).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
		});

		it('should consume multiple units of capacity if cost > 1', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'reject',
				burst: 5,
				intervalMs: 100,
				clock,
				store,
			});

			await expect(limiter.run(() => 'A', { cost: 3 })).resolves.toBe('A');
			await expect(limiter.run(() => 'B', { cost: 3 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
			});
		});

		it('should allow new requests after the interval has passed', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'reject',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			await limiter.run(() => 'A');
			await expect(limiter.run(() => 'B')).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });

			// next TAT
			await vi.advanceTimersByTimeAsync(100);

			await expect(limiter.run(() => 'C')).resolves.toBe('C');
		});
	});

	describe('Enqueue mode (queueing & scheduling)', () => {
		it('should delay request and execute it when the interval permits', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			void limiter.run(() => 'A');

			const bSpy = vi.fn().mockReturnValue('B');
			// delay 100ms
			const pB = limiter.run(bSpy);

			expect(bSpy).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(100);

			const result: unknown = await pB;
			expect(bSpy).toHaveBeenCalledOnce();
			expect(result).toBe('B');
		});

		it('should maintain order and timings for multiple queued requests', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			void limiter.run(() => {});

			const results: string[] = [];

			// delay 100ms
			const pA = limiter.run(() => results.push('A'));
			// delay 200ms
			const pB = limiter.run(() => results.push('B'));
			// delay 300ms
			const pC = limiter.run(() => results.push('C'));

			await vi.advanceTimersByTimeAsync(100);
			await pA;
			expect(results).toEqual(['A']);

			await vi.advanceTimersByTimeAsync(100);
			await pB;
			expect(results).toEqual(['A', 'B']);

			await vi.advanceTimersByTimeAsync(100);
			await pC;
			expect(results).toEqual(['A', 'B', 'C']);
		});

		it('should reject with QueueOverflow if executor queue exceeds maxSize', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				queue: { capacity: 1 },
				clock,
				store,
			});

			// exhausts burst
			const pA = limiter.run(() => 'A');
			// enqueued
			const pB = limiter.run(() => 'B');

			await vi.advanceTimersByTimeAsync(0);

			// overflow
			const pC = limiter.run(() => 'C');

			await expect(pC).rejects.toMatchObject({ code: RateLimitErrorCode.QueueOverflow });

			await vi.advanceTimersByTimeAsync(0);
			await expect(pA).resolves.toBe('A');

			await vi.advanceTimersByTimeAsync(100);
			await expect(pB).resolves.toBe('B');
		});

		it('should execute queued tasks based on priority order', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			await limiter.run(() => 'A');

			const order: string[] = [];

			void limiter.run(() => order.push('Lowest'), { priority: 1 });
			void limiter.run(() => order.push('Highest'), { priority: 5 });

			await vi.advanceTimersByTimeAsync(200);

			expect(order).toEqual(['Highest', 'Lowest']);
		});

		it('should enqueue the task and reject it with Expired when TTL is reached', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				queue: { maxWaitMs: 150 },
				clock,
				store,
			});

			const pA = limiter.run(() => 'A');
			// delay 100ms
			const pB = limiter.run(() => 'B');
			// delay 200ms, expires after 150ms
			const spyC = vi.fn().mockReturnValue('C');
			const pC = limiter.run(spyC);
			pC.catch(() => {});

			await expect(pA).resolves.toBe('A');

			await vi.advanceTimersByTimeAsync(100);
			await expect(pB).resolves.toBe('B');
			expect(spyC).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(50);
			await expect(pC).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });
			expect(spyC).not.toHaveBeenCalled();
		});

		it('should free up the canceled ticket for new requests', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			const pA = limiter.run(() => 'A');

			const controllerB = new AbortController();
			// delay 100ms
			const pB = limiter.run(() => 'B', { signal: controllerB.signal });

			const spyC = vi.fn().mockReturnValue('C');
			// delay 200ms
			const pC = limiter.run(spyC);

			await vi.advanceTimersByTimeAsync(0);

			// canceling B
			// the 200ms ticket should be freed up, the consumed token should be returned to the bucket
			controllerB.abort();
			await expect(pB).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled });

			const spyD = vi.fn().mockReturnValue('D');
			// delay 200ms (it was freed up by canceling B)
			const pD = limiter.run(spyD);

			await expect(pA).resolves.toBe('A');
			expect(spyC).not.toHaveBeenCalled();
			expect(spyD).not.toHaveBeenCalled();

			// t = 10_100
			// C takes the 100ms ticket created by B
			await vi.advanceTimersByTimeAsync(100);

			await expect(pC).resolves.toBe('C');
			expect(spyC).toHaveBeenCalledOnce();
			expect(spyD).not.toHaveBeenCalled();

			// t = 10_200
			// D takes the 200ms ticket created by itself
			await vi.advanceTimersByTimeAsync(100);

			await expect(pD).resolves.toBe('D');
			expect(spyD).toHaveBeenCalledOnce();
		});

		it('should force enqueue task even if queue is full when shouldForceEnqueue is true', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				queue: { capacity: 1 },
				clock,
				store,
			});

			void limiter.run(() => {});

			const taskA = vi.fn().mockResolvedValue('A');
			const taskB = vi.fn().mockResolvedValue('B');
			const taskC = vi.fn().mockResolvedValue('C');

			const pA = limiter.run(taskA, { id: 'A' });
			const pB = limiter.run(taskB, { id: 'B', shouldForceEnqueue: false });

			await expect(pB).rejects.toMatchObject({ code: RateLimitErrorCode.QueueOverflow });

			const pC = limiter.run(taskC, { id: 'C', shouldForceEnqueue: true });

			await vi.advanceTimersByTimeAsync(100);

			expect(taskA).toHaveBeenCalledOnce();
			await expect(pA).resolves.toBe('A');

			await vi.advanceTimersByTimeAsync(100);

			expect(taskC).toHaveBeenCalledOnce();
			await expect(pC).resolves.toBe('C');
		});
	});

	describe('Runtime overrides', () => {
		it('should allow overriding limitBehavior per task', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'reject',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			await limiter.run(() => 'A');
			const pB = limiter.run(() => 'B', { limitBehavior: 'enqueue' });

			await vi.advanceTimersByTimeAsync(100);
			await expect(pB).resolves.toBe('B');
		});

		it('should override max wait time for a specific task and expire it independently', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'enqueue',
				burst: 1,
				intervalMs: 100,
				queue: { maxWaitMs: 5000 },
				clock,
				store,
			});

			void limiter.run(() => 'A');

			// delay 100ms
			const pB = limiter.run(() => 'B');

			// delay 200ms
			// expires after 150ms, so it should be rejected
			const pC = limiter.run(() => 'C', { maxWaitMs: 150 });
			pC.catch(() => {});

			// delay 300ms
			const pD = limiter.run(() => 'D', { maxWaitMs: 400 });

			// t=10_100
			await vi.advanceTimersByTimeAsync(100);
			await expect(pB).resolves.toBe('B');

			// t=10_150
			await vi.advanceTimersByTimeAsync(50);
			await expect(pC).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });

			// t=10_300
			await vi.advanceTimersByTimeAsync(150);
			await expect(pD).resolves.toBe('D');
		});
	});

	describe('State lifecycle', () => {
		it('should reset limits and clear queued tasks on clear()', async () => {
			const limiter = new GenericCellLimiter({
				limitBehavior: 'reject',
				burst: 1,
				intervalMs: 100,
				clock,
				store,
			});

			await limiter.run(() => 'A');

			await limiter.clear();

			await expect(limiter.run(() => 'B')).resolves.toBe('B');
		});

		it('should throw RateLimitError(Destroyed) after destroy() is called', async () => {
			const limiter = new GenericCellLimiter({
				burst: 5,
				intervalMs: 100,
				clock,
				store,
			});

			await limiter.destroy();

			await expect(limiter.run(() => 'A')).rejects.toThrow(RateLimiterDestroyedError);
		});
	});
});
