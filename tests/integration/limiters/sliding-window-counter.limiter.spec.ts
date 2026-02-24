import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Clock, RateLimiterDestroyedError, RateLimitErrorCode } from '../../../src/index.js';
import {
	SlidingWindowCounterLimiter,
	type SlidingWindowCounterState,
} from '../../../src/limiters/sliding-window-counter/index.js';
import { InMemoryStateStore } from '../../../src/runtime/in-memory-state-store.js';

describe('SlidingWindowCounterLimiter (Integration)', () => {
	let clock: Clock;
	let store: InMemoryStateStore<SlidingWindowCounterState>;

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
			const limiter = new SlidingWindowCounterLimiter({
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
			const limiter = new SlidingWindowCounterLimiter({
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
			const limiter = new SlidingWindowCounterLimiter({
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

	describe('Window approximation & slides', () => {
		it('should completely reset the limit after two full windows have passed', async () => {
			const limiter = new SlidingWindowCounterLimiter({
				limit: 1,
				windowMs: 1000,
				clock,
				store,
			});

			await limiter.run(() => 'A');
			await expect(limiter.run(() => 'B')).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });

			await vi.advanceTimersByTimeAsync(2000);

			await expect(limiter.run(() => 'C')).resolves.toBe('C');
		});

		it('should approximate available capacity based on the weighted previous window', async () => {
			const limiter = new SlidingWindowCounterLimiter({
				limit: 10,
				windowMs: 1000,
				clock,
				store,
			});

			await limiter.run(() => 'A', { cost: 10 });
			await vi.advanceTimersByTimeAsync(1250);

			await expect(limiter.run(() => 'B', { cost: 4 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
			});

			await expect(limiter.run(() => 'C', { cost: 3 })).resolves.toBe('C');
		});

		it('should smoothly decrease weight of previous window as time passes', async () => {
			const limiter = new SlidingWindowCounterLimiter({
				limit: 10,
				windowMs: 1000,
				clock,
				store,
			});

			void limiter.run(() => 'A', { cost: 10 });

			await vi.advanceTimersByTimeAsync(1500);

			await expect(limiter.run(() => 'B', { cost: 5 })).resolves.toBe('B');

			await vi.advanceTimersByTimeAsync(400);
			await expect(limiter.run(() => 'C', { cost: 5 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
			});
			await expect(limiter.run(() => 'D', { cost: 4 })).resolves.toBe('D');
		});
	});

	describe('Cancellation', () => {
		it('should reject immediately if the abort signal is already triggered', async () => {
			const limiter = new SlidingWindowCounterLimiter({
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
			const limiter = new SlidingWindowCounterLimiter({
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
			const limiter = new SlidingWindowCounterLimiter({
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
