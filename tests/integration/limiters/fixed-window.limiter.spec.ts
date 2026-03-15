import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Clock, RateLimiterDestroyedError, RateLimitErrorCode } from '../../../src/index.js';
import { FixedWindowLimiter, type FixedWindowState } from '../../../src/limiters/fixed-window/index.js';
import { InMemoryStateStore } from '../../../src/runtime/in-memory-state-store.js';

describe('FixedWindowLimiter (Integration)', () => {
	let clock: Clock;
	let store: InMemoryStateStore<FixedWindowState[]>;

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
		it('should allow requests within the limit immediately', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'reject',
				limitOptions: { limit: 2, windowMs: 1000 },
				clock,
				store,
			});

			const res1 = await limiter.run(async () => 'A');
			const res2 = await limiter.run(async () => 'B');

			expect(res1).toBe('A');
			expect(res2).toBe('B');
		});

		it('should reject requests that exceed the limit if behavior is "reject"', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'reject',
				limitOptions: { limit: 1, windowMs: 1000 },
				clock,
				store,
			});

			await limiter.run(() => 'A');

			const promise = limiter.run(() => 'B');
			await expect(promise).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
		});

		it('should consume multiple tokens if cost > 1', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'reject',
				limitOptions: { limit: 5, windowMs: 1000 },
				clock,
				store,
			});

			await expect(limiter.run(() => 'A', { cost: 3 })).resolves.toBe('A');
			await expect(limiter.run(() => 'B', { cost: 3 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
			});
		});
	});

	describe('Enqueue mode (queueing & scheduling)', () => {
		it('should delay request and execute it in the next window', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 1, windowMs: 1000 },
				clock,
				store,
			});

			const spy = vi.fn().mockReturnValue('B');

			// window 10_000
			await limiter.run(() => 'A');

			// enqueued for 11_000
			const pendingPromise = limiter.run<unknown>(spy);

			expect(spy).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1000);

			const result = await pendingPromise;
			expect(spy).toHaveBeenCalledOnce();
			expect(result).toBe('B');
		});

		it('should maintain order and timings for multiple queued requests', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 1, windowMs: 1000 },
				clock,
				store,
			});

			const results: string[] = [];
			const push = (val: string) => () => results.push(val);

			// instantly executed
			const pA = limiter.run(push('A'));
			// enqueued for 11_000
			const pB = limiter.run(push('B'));
			// enqueued for 12_000
			const pC = limiter.run(push('C'));

			await pA;
			expect(results).toEqual(['A']);

			// t = 11_000
			await vi.advanceTimersByTimeAsync(1000);
			await pB;
			expect(results).toEqual(['A', 'B']);

			// t = 12_000
			await vi.advanceTimersByTimeAsync(1000);
			await pC;
			expect(results).toEqual(['A', 'B', 'C']);
		});

		it('should reject with QueueOverflow if executor queue exceeds capacity', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 1, windowMs: 1000 },
				queue: { capacity: 1 },
				clock,
				store,
			});

			const pA = limiter.run(() => 'A');
			const pB = limiter.run(() => 'B');

			// overflow
			const pC = limiter.run(() => 'C');

			await expect(pC).rejects.toMatchObject({ code: RateLimitErrorCode.QueueOverflow });

			await vi.advanceTimersByTimeAsync(0);
			await expect(pA).resolves.toBe('A');

			await vi.advanceTimersByTimeAsync(1000);
			await expect(pB).resolves.toBe('B');
		});

		it('should execute queued tasks based on priority order, not just chronological', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 2, windowMs: 1000 },
				clock,
				store,
			});

			void limiter.run(() => 'A', { priority: 1 });
			void limiter.run(() => 'B', { priority: 1 });

			const order: string[] = [];

			void limiter.run(() => order.push('Lowest'), { priority: 1 });
			void limiter.run(() => order.push('Highest'), { priority: 5 });

			await vi.advanceTimersByTimeAsync(1000);

			expect(order).toEqual(['Highest', 'Lowest']);
		});

		it('should enqueue the task and reject it with Expired when TTL is reached', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 1, windowMs: 1000 },
				queue: { maxWaitMs: 1500 },
				clock,
				store,
			});

			// immediately executed
			const pA = limiter.run(() => 'A');
			// expected t = 11_000, expires at 11_500
			const pB = limiter.run(() => 'B');
			// expected t = 12_000 but expires at 11_500
			const spyC = vi.fn().mockReturnValue('C');
			const pC = limiter.run(spyC);
			pC.catch(() => {});

			await expect(pA).resolves.toBe('A');

			// t = 11_000
			await vi.advanceTimersByTimeAsync(1000);

			await expect(pB).resolves.toBe('B');

			expect(spyC).not.toHaveBeenCalled();

			// t = 11_500
			await vi.advanceTimersByTimeAsync(500);

			await expect(pC).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });
			expect(spyC).not.toHaveBeenCalled();
		});

		it('should free up the canceled ticket for new requests, while keeping already queued requests at their scheduled time', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 1, windowMs: 1000 },
				clock,
				store,
			});

			// tA = 10_000 (now)
			const pA = limiter.run(() => 'A');

			// tB = 11_000
			const controllerB = new AbortController();
			const pB = limiter.run(() => 'B', { signal: controllerB.signal });

			// tC = 12_000
			const spyC = vi.fn().mockReturnValue('C');
			const pC = limiter.run(spyC);

			// settle
			await vi.advanceTimersByTimeAsync(0);

			// cancel B before t = 11_000
			controllerB.abort();
			await expect(pB).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled });

			// tD = 12_000 (instead of 13_000, because B was canceled before execution)
			const spyD = vi.fn().mockReturnValue('D');
			const pD = limiter.run(spyD);

			await expect(pA).resolves.toBe('A');
			expect(spyC).not.toHaveBeenCalled();
			expect(spyD).not.toHaveBeenCalled();

			// t = 11_000
			await vi.advanceTimersByTimeAsync(1000);

			// C should take the ticket created by B (that was canceled)
			await expect(pC).resolves.toBe('C');
			expect(spyC).toHaveBeenCalledOnce();

			expect(spyD).not.toHaveBeenCalled();

			// t = 12_000
			await vi.advanceTimersByTimeAsync(1000);

			await expect(pD).resolves.toBe('D');
			expect(spyD).toHaveBeenCalledOnce();
		});

		it('should force enqueue task even if queue is full when shouldForceEnqueue is true', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 1, windowMs: 100 },
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

	describe('Multiple windows', () => {
		it('should respect the most restrictive limit in composite policies', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: [
					{ limit: 2, windowMs: 1000 },
					{ limit: 3, windowMs: 5000 },
				],
				clock,
				store,
			});

			// t = 10_000 (now)
			void limiter.run(() => 'A'); // 1/2 (1s), 1/3 (5s)
			void limiter.run(() => 'B'); // 2/2 (1s), 2/3 (5s)

			// 1s limit; delayed to 11_000 window
			const pC = limiter.run(() => 'C'); // 1/2 (1s), 3/3 (5s)

			// 5s limit; delayed to 15_000 window
			const pD = limiter.run(() => 'D');

			await vi.advanceTimersByTimeAsync(1000);
			await expect(pC).resolves.toBe('C');

			// t = 12_000
			await vi.advanceTimersByTimeAsync(1000);

			let dResolved = false;
			void pD.then(() => {
				dResolved = true;
			});

			await vi.advanceTimersByTimeAsync(0);

			expect(dResolved).toBe(false);

			// t = 15_000
			await vi.advanceTimersByTimeAsync(3000);

			await expect(pD).resolves.toBe('D');
		});
	});

	describe('Runtime overrides', () => {
		it('should allow overriding limitBehavior per task', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'reject',
				limitOptions: { limit: 1, windowMs: 1000 },
				clock,
				store,
			});

			await limiter.run(() => 'A');
			const pB = limiter.run(() => 'B', { limitBehavior: 'enqueue' });

			await vi.advanceTimersByTimeAsync(1000);
			await expect(pB).resolves.toBe('B');
		});

		it('should override max wait time for a specific task and expire it independently', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'enqueue',
				limitOptions: { limit: 1, windowMs: 1000 },
				queue: { maxWaitMs: 5000 },
				clock,
				store,
			});

			void limiter.run(() => 'A');

			const pB = limiter.run(() => 'B');
			const pC = limiter.run(() => 'C', { maxWaitMs: 1500 });
			pC.catch(() => {});
			const pD = limiter.run(() => 'D', { maxWaitMs: 4000 });

			await vi.advanceTimersByTimeAsync(1000);
			await expect(pB).resolves.toBe('B');

			await vi.advanceTimersByTimeAsync(500);
			await expect(pC).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });

			await vi.advanceTimersByTimeAsync(1500);
			await expect(pD).resolves.toBe('D');
		});
	});

	describe('State lifecycle', () => {
		it('should reset limits and clear queued tasks on clear()', async () => {
			const limiter = new FixedWindowLimiter({
				limitBehavior: 'reject',
				limitOptions: { limit: 1, windowMs: 1000 },
				clock,
				store,
			});

			await limiter.run(() => 'A');

			await limiter.clear();

			await expect(limiter.run(() => 'B')).resolves.toBe('B');
		});

		it('should throw RateLimiterDestroyedError after destroy() is called', async () => {
			const limiter = new FixedWindowLimiter({
				limitOptions: { limit: 5, windowMs: 1000 },
				clock,
				store,
			});

			await limiter.destroy();

			await expect(limiter.run(() => 'A')).rejects.toThrow(RateLimiterDestroyedError);
		});
	});
});
