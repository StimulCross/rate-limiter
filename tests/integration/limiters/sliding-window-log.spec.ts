import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Clock, RateLimiterDestroyedError, RateLimitErrorCode } from '../../../src/index.js';
import { SlidingWindowLogLimiter, type SlidingWindowLogState } from '../../../src/limiters/sliding-window-log/index.js';
import { InMemoryStateStore } from '../../../src/runtime/in-memory-state-store.js';

describe('SlidingWindowLogLimiter (Integration)', () => {
	let clock: Clock;
	let store: InMemoryStateStore<SlidingWindowLogState>;

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

	describe('Immediate decisions', () => {
		it('should allow requests within the limit immediately', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 2,
				windowMs: 1000,
				clock,
				store,
			});

			const res1 = await limiter.run(async () => 'A');
			const res2 = await limiter.run(async () => 'B');

			expect(res1).toBe('A');
			expect(res2).toBe('B');
		});

		it('should reject requests that exceed the limit', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 1,
				windowMs: 1000,
				clock,
				store,
			});

			await limiter.run(() => 'A');

			const promise = limiter.run(() => 'B');
			await expect(promise).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
		});

		it('should consume multiple units of capacity if cost > 1', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 5,
				windowMs: 1000,
				clock,
				store,
			});

			await expect(limiter.run(() => 'A', { cost: 3 })).resolves.toBe('A');
			await expect(limiter.run(() => 'B', { cost: 3 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
			});
		});
	});

	describe('Precise log cleanup & sliding window', () => {
		it('should completely reset the limit after the full window has passed without activity', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 1,
				windowMs: 1000,
				clock,
				store,
			});

			await limiter.run(() => 'A');
			await expect(limiter.run(() => 'B')).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });

			await vi.advanceTimersByTimeAsync(1000);

			await expect(limiter.run(() => 'C')).resolves.toBe('C');
		});

		it('should restore capacity precisely as old requests fall out of the window', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 2,
				windowMs: 1000,
				clock,
				store,
			});

			// t = 10_000
			await limiter.run(() => 'A');

			// t = 10_400
			await vi.advanceTimersByTimeAsync(400);
			await limiter.run(() => 'B');

			// capacity 2/2
			await expect(limiter.run(() => 'C')).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });

			// t = 11_000 (A expires)
			await vi.advanceTimersByTimeAsync(600);

			// capacity 1/2
			await expect(limiter.run(() => 'D')).resolves.toBe('D');
			await expect(limiter.run(() => 'E')).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });

			// t = 11_400 (B expires)
			await vi.advanceTimersByTimeAsync(400);

			// capacity 1/2 (D is still in window)
			await expect(limiter.run(() => 'F')).resolves.toBe('F');
		});

		it('should aggregate simultaneous requests into a single log entry but count their total cost', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 5,
				windowMs: 1000,
				clock,
				store,
			});

			// t = 10_000
			void limiter.run(() => 'A', { cost: 2 });
			void limiter.run(() => 'B', { cost: 3 });

			await expect(limiter.run(() => 'C')).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });

			// t = 11_000 (Both A and B expire simultaneously)
			await vi.advanceTimersByTimeAsync(1000);

			await expect(limiter.run(() => 'D', { cost: 5 })).resolves.toBe('D');
		});
	});

	describe('Cancellation', () => {
		it('should reject immediately if the abort signal is already triggered', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 1,
				windowMs: 1000,
				clock,
				store,
			});

			const controller = new AbortController();
			controller.abort();

			await expect(limiter.run(() => 'A', { signal: controller.signal })).rejects.toMatchObject({
				code: RateLimitErrorCode.Cancelled,
			});
		});
	});

	describe('State lifecycle', () => {
		it('should reset limits on clear()', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 1,
				windowMs: 1000,
				clock,
				store,
			});

			await limiter.run(() => 'A');

			await limiter.clear();

			await expect(limiter.run(() => 'B')).resolves.toBe('B');
		});

		it('should throw RateLimitError(Destroyed) after destroy() is called', async () => {
			const limiter = new SlidingWindowLogLimiter({
				limit: 5,
				windowMs: 1000,
				clock,
				store,
			});

			await limiter.destroy();

			await expect(limiter.run(() => 'A')).rejects.toThrow(RateLimiterDestroyedError);
		});
	});
});
