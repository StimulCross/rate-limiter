import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Clock, RateLimiterDestroyedError, RateLimitErrorCode } from '../../../src/index.js';
import {
	type HttpLimitInfo,
	type HttpLimitInfoExtractor,
	HttpResponseBasedLimiter,
	type HttpResponseBasedLimiterState,
} from '../../../src/limiters/http-response-based/index.js';
import { InMemoryStateStore } from '../../../src/runtime/in-memory-state-store.js';

describe('HttpResponseBasedLimiter (Integration)', () => {
	let clock: Clock;
	let store: InMemoryStateStore<HttpResponseBasedLimiterState>;
	let mockExtractor: HttpLimitInfoExtractor<any> & ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);

		clock = { now: () => Date.now() };
		store = new InMemoryStateStore(clock);
		mockExtractor = vi.fn<HttpLimitInfoExtractor<any>>(res => res?.headers || null);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	describe('Immediate execution (reject mode)', () => {
		it('should allow the first request and sync state from response', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn().mockReturnValue({
				headers: { limit: 10, remaining: 9, resetAt: 15_000, statusCode: 200 } satisfies HttpLimitInfo,
			});

			await expect(limiter.run(task)).resolves.toBeDefined();

			const status = await limiter.getStatus();
			expect(status.lastKnownLimit).toBe(10);
			expect(status.lastKnownRemaining).toBe(9);
			expect(status.lastKnownResetAt).toBe(15_000);
		});

		it('should block subsequent requests if network returns successful response with 0 remaining tokens', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const taskA = vi.fn().mockReturnValue({
				headers: { limit: 5, remaining: 0, resetAt: 15_000, statusCode: 200 } satisfies HttpLimitInfo,
			});
			const taskB = vi.fn();

			await expect(limiter.run(taskA)).resolves.toBeDefined();
			await expect(limiter.run(taskB)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
			expect(taskB).not.toHaveBeenCalled();
		});

		it('should reject request immediately if local state indicates limit is reached', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 5,
					lastKnownRemaining: 0,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 10_000,
				},
				5000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn();

			await expect(limiter.run(task)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
			expect(task).not.toHaveBeenCalled();
		});

		it('should reject when network responds with limit exceeded (HTTP 429)', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn().mockReturnValue({
				headers: { limit: 5, remaining: 0, resetAt: 15_000, statusCode: 429 } satisfies HttpLimitInfo,
			});

			await expect(limiter.run(task)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
			expect(task).toHaveBeenCalledOnce();

			const status = await limiter.getStatus();
			expect(status.lastKnownRemaining).toBe(0);
		});

		it('should sync state and re-throw error if task throws but provides limit headers', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: (res, err) => (err as any)?.response?.headers || null,
				clock,
				store,
			});

			const customError = new Error('Bad Request');
			(customError as any).response = {
				headers: { limit: 10, remaining: 5, resetAt: 15_000, statusCode: 400 } satisfies HttpLimitInfo,
			};

			const task = vi.fn().mockRejectedValue(customError);

			await expect(limiter.run(task)).rejects.toThrow(customError);

			const status = await limiter.getStatus();
			expect(status.lastKnownRemaining).toBe(5);
			expect(status.lastKnownResetAt).toBe(15_000);
		});

		it('should fallback to default delay if server does not provide reset time', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				fallbackResetDelayMs: 45_000,
				clock,
				store,
			});

			const task = vi.fn().mockReturnValue({
				headers: {
					limit: 10,
					remaining: 9,
					resetAt: undefined,
					statusCode: 200,
				},
			});

			await limiter.run(task);

			const status = await limiter.getStatus();
			expect(status.lastKnownResetAt).toBe(55_000);
		});
	});

	describe('Queueing execution (enqueue mode)', () => {
		it('should requeue and retry request if network responds with HTTP 429', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'enqueue',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			let calls = 0;
			const task = vi.fn(() => {
				calls++;

				if (calls === 1) {
					return {
						headers: { limit: 5, remaining: 0, resetAt: 11_000, statusCode: 429 } satisfies HttpLimitInfo,
					};
				}
				return {
					headers: {
						limit: 5,
						remaining: 4,
						resetAt: 12_000,
						statusCode: 200,
					} satisfies HttpLimitInfo,
				};
			});

			const promise = limiter.run(task);

			await vi.advanceTimersByTimeAsync(0);
			// task hit 429 and enqueued
			expect(calls).toBe(1);

			// wait for resetAt (11_000)
			await vi.advanceTimersByTimeAsync(1000);
			await expect(promise).resolves.toBeDefined();
			expect(calls).toBe(2);
		});

		it('should delay request locally without network call if state is exhausted', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 5,
					lastKnownRemaining: 0,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 10_000,
				},
				5000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'enqueue',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn().mockReturnValue({
				headers: { limit: 5, remaining: 4, resetAt: 20_000, statusCode: 200 } satisfies HttpLimitInfo,
			});

			const promise = limiter.run(task);

			await vi.advanceTimersByTimeAsync(1000);
			expect(task).not.toHaveBeenCalled();

			// Reach 15_000
			await vi.advanceTimersByTimeAsync(4000);
			await expect(promise).resolves.toBeDefined();
			expect(task).toHaveBeenCalledOnce();
		});

		it('should reject with Expired when TTL is reached while waiting in queue', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 5,
					lastKnownRemaining: 0,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 10_000,
				},
				5000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'enqueue',
				limitInfoExtractor: mockExtractor,
				queue: { maxWaitMs: 1000 },
				clock,
				store,
			});

			const promise = limiter.run(vi.fn());
			promise.catch(() => {});

			await vi.advanceTimersByTimeAsync(1000);
			await expect(promise).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });
		});

		it('should abort queued tasks when signal is aborted', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 5,
					lastKnownRemaining: 0,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 10_000,
				},
				5000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'enqueue',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const controller = new AbortController();
			const promise = limiter.run(vi.fn(), { signal: controller.signal });

			await vi.advanceTimersByTimeAsync(0);
			controller.abort();

			await expect(promise).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled });
		});
	});

	describe('Concurrency & Syncing', () => {
		it('should gracefully queue followers while probe is resolving initial state', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const taskA = vi.fn().mockImplementation(
				() =>
					new Promise(resolve =>
						setTimeout(
							() =>
								resolve({
									headers: {
										limit: 10,
										remaining: 9,
										resetAt: 15_000,
										statusCode: 200,
									} satisfies HttpLimitInfo,
								}),
							500,
						),
					),
			);

			const taskB = vi.fn().mockReturnValue({
				headers: { limit: 10, remaining: 8, resetAt: 15_000, statusCode: 200 } satisfies HttpLimitInfo,
			});

			const promiseA = limiter.run(taskA);

			// advance time to allow taskA to become the probe and lock
			await vi.advanceTimersByTimeAsync(10);

			// should wait, not reject
			const promiseB = limiter.run(taskB);

			expect(taskB).not.toHaveBeenCalled();

			// taskA completes
			await vi.advanceTimersByTimeAsync(500);

			await expect(promiseA).resolves.toBeDefined();
			await expect(promiseB).resolves.toBeDefined();

			expect(taskA).toHaveBeenCalledOnce();
			expect(taskB).toHaveBeenCalledOnce();
		});

		it('should rollback probing state and allow next request to become probe if initial probe fails without headers', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const taskA = vi
				.fn()
				.mockImplementation(
					() => new Promise((_, reject) => setTimeout(() => reject(new Error('Network Failure')), 500)),
				);

			const taskB = vi.fn().mockImplementation(
				() =>
					new Promise(resolve =>
						setTimeout(
							() =>
								resolve({
									headers: {
										limit: 10,
										remaining: 9,
										resetAt: 15_000,
										statusCode: 200,
									} satisfies HttpLimitInfo,
								}),
							100,
						),
					),
			);

			const pA = limiter.run(taskA);
			pA.catch(() => {});
			await vi.advanceTimersByTimeAsync(10);

			// should wait taskA
			const pB = limiter.run(taskB);

			// taskA rejects
			await vi.advanceTimersByTimeAsync(500);
			await expect(pA).rejects.toThrow('Network Failure');

			// taskB becomes the new probe
			await vi.advanceTimersByTimeAsync(100);
			await expect(pB).resolves.toBeDefined();

			const status = await limiter.getStatus();
			expect(status.lastKnownRemaining).toBe(9);
			expect(taskB).toHaveBeenCalledOnce();
		});

		it('should abort follower waiting for probe to finish', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const taskA = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 500)));

			const pA = limiter.run(taskA);
			// taskA becomes probe
			await vi.advanceTimersByTimeAsync(10);

			const controller = new AbortController();
			const pB = limiter.run(vi.fn(), { signal: controller.signal });

			controller.abort();
			await expect(pB).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled });

			await vi.advanceTimersByTimeAsync(500);
			await pA.catch(() => {});
		});

		it('should optimistically debit tokens for concurrent requests', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 10,
					lastKnownRemaining: 5,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 10_000,
				},
				5000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn().mockImplementation(
				() =>
					new Promise(resolve =>
						setTimeout(
							() =>
								resolve({
									headers: {
										limit: 10,
										remaining: 4,
										resetAt: 15_000,
										statusCode: 200,
									} satisfies HttpLimitInfo,
								}),
							200,
						),
					),
			);

			const p1 = limiter.run(task);
			const p2 = limiter.run(task);

			await vi.advanceTimersByTimeAsync(10);

			const interimState = await store.get('limiter');
			expect(interimState?.lastKnownRemaining).toBe(3);

			await vi.advanceTimersByTimeAsync(200);
			await Promise.all([p1, p2]);
		});

		it('should ignore stale headers if a newer request already synced the state', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 10,
					lastKnownRemaining: 10,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 9000,
				},
				10_000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const slowTask = vi.fn().mockImplementation(
				() =>
					new Promise(resolve =>
						setTimeout(
							() =>
								resolve({
									headers: {
										limit: 10,
										remaining: 9,
										resetAt: 15_000,
										statusCode: 200,
									} satisfies HttpLimitInfo,
								}),
							500,
						),
					),
			);

			const fastTask = vi.fn().mockImplementation(
				() =>
					new Promise(resolve =>
						setTimeout(
							() =>
								resolve({
									headers: {
										limit: 10,
										remaining: 8,
										resetAt: 15_000,
										statusCode: 200,
									} satisfies HttpLimitInfo,
								}),
							100,
						),
					),
			);

			const pSlow = limiter.run(slowTask);
			await vi.advanceTimersByTimeAsync(100);

			const pFast = limiter.run(fastTask);

			await vi.advanceTimersByTimeAsync(100);
			await pFast;

			const interimStatus = await limiter.getStatus();
			expect(interimStatus.lastKnownRemaining).toBe(8);

			await vi.advanceTimersByTimeAsync(300);
			await pSlow;

			const finalStatus = await limiter.getStatus();
			expect(finalStatus.lastKnownRemaining).toBe(8);
		});
	});

	describe('Unlimited mode', () => {
		it('should cache unlimited state if server responds without rate limit headers', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: vi.fn().mockReturnValue(null),
				clock,
				store,
			});

			await limiter.run(vi.fn().mockResolvedValue('ok'));

			const status = await limiter.getStatus();
			expect(status.lastKnownLimit).toBe(null);
			expect(status.lastKnownRemaining).toBe(null);
		});

		it('should bypass local blocking if state is unlimited', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: true,
					lastKnownLimit: Number.MAX_SAFE_INTEGER,
					lastKnownRemaining: Number.MAX_SAFE_INTEGER,
					lastKnownResetAt: 70_000,
					lastSyncedAt: 10_000,
				},
				60_000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: vi.fn().mockReturnValue(null),
				clock,
				store,
			});

			const task = vi.fn().mockResolvedValue('ok');
			await expect(limiter.run(task)).resolves.toBe('ok');
			expect(task).toHaveBeenCalledOnce();
		});

		it('should ignore unlimited state cache if a newer request already synced actual limits', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 10,
					lastKnownRemaining: 10,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 9000,
				},
				10_000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const slowTask = vi
				.fn()
				.mockImplementation(
					() => new Promise((_, reject) => setTimeout(() => reject(new Error('Network Error')), 500)),
				);

			const fastTask = vi.fn().mockImplementation(
				() =>
					new Promise(resolve =>
						setTimeout(
							() =>
								resolve({
									headers: {
										limit: 10,
										remaining: 8,
										resetAt: 15_000,
										statusCode: 200,
									} satisfies HttpLimitInfo,
								}),
							100,
						),
					),
			);

			const pSlow = limiter.run(slowTask);
			pSlow.catch(() => {});
			await vi.advanceTimersByTimeAsync(100);

			const pFast = limiter.run(fastTask);

			await vi.advanceTimersByTimeAsync(100);
			await pFast;

			await vi.advanceTimersByTimeAsync(300);
			await pSlow.catch(() => {});

			const finalStatus = await limiter.getStatus();
			expect(finalStatus.lastKnownRemaining).toBe(8);
		});

		it('should strictly bypass local limit checks and remain unlimited if server continues to omit headers', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: true,
					lastKnownLimit: null,
					lastKnownRemaining: null,
					lastKnownResetAt: 70_000,
					lastSyncedAt: 10_000,
				},
				60_000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: vi.fn().mockReturnValue(null),
				clock,
				store,
			});

			const task = vi.fn().mockResolvedValue('ok');

			await expect(limiter.run(task)).resolves.toBe('ok');
			expect(task).toHaveBeenCalledOnce();

			const status = await limiter.getStatus();
			expect(status.isUnlimited).toBe(true);
		});

		it('should instantly transition from unlimited to limited if server suddenly sends headers', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: true,
					lastKnownLimit: null,
					lastKnownRemaining: null,
					lastKnownResetAt: 70_000,
					lastSyncedAt: 10_000,
				},
				60_000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn().mockReturnValue({
				headers: { limit: 10, remaining: 9, resetAt: 15_000, statusCode: 200 } satisfies HttpLimitInfo,
			});

			await expect(limiter.run(task)).resolves.toBeDefined();

			const status = await limiter.getStatus();
			expect(status.isUnlimited).toBe(false);
			expect(status.lastKnownLimit).toBe(10);
			expect(status.lastKnownRemaining).toBe(9);
		});
	});

	describe('State & Lifecycle', () => {
		it('should clear limits and reset state', async () => {
			await store.set(
				'limiter',
				{
					isProbing: false,
					isUnlimited: false,
					lastKnownLimit: 5,
					lastKnownRemaining: 0,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 10_000,
				},
				5000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			await limiter.clear();

			const status = await limiter.getStatus();
			expect(status.lastKnownLimit).toBe(null);
			expect(status.lastKnownRemaining).toBe(null);
		});

		it('should throw RateLimiterDestroyedError after destroy() is called', async () => {
			const limiter = new HttpResponseBasedLimiter({
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			await limiter.destroy();

			await expect(limiter.run(vi.fn())).rejects.toThrow(RateLimiterDestroyedError);
		});
	});

	describe('Fault Tolerance & Edge Cases', () => {
		it('should reject immediately if another remote instance is probing and limit is reached', async () => {
			await store.set(
				'limiter',
				{
					isProbing: true,
					isUnlimited: false,
					lastKnownLimit: 1,
					lastKnownRemaining: 0,
					lastKnownResetAt: 15_000,
					lastSyncedAt: 10_000,
				},
				5000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn();

			await expect(limiter.run(task)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
			expect(task).not.toHaveBeenCalled();
		});

		it('should recover from an orphaned soft lock after its logical TTL expires', async () => {
			// simulate a lock left by a process that crashed before syncing
			await store.set(
				'limiter',
				{
					isProbing: true,
					isUnlimited: false,
					lastKnownLimit: 1,
					lastKnownRemaining: 0,
					lastKnownResetAt: 12_000,
					lastSyncedAt: 10_000,
				},
				2000,
			);

			const limiter = new HttpResponseBasedLimiter({
				limitBehavior: 'reject',
				limitInfoExtractor: mockExtractor,
				clock,
				store,
			});

			const task = vi.fn().mockReturnValue({
				headers: { limit: 10, remaining: 9, resetAt: 15_000, statusCode: 200 } satisfies HttpLimitInfo,
			});

			// lock is active (t=11_000)
			await vi.advanceTimersByTimeAsync(1000);
			await expect(limiter.run(task)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded });
			expect(task).not.toHaveBeenCalled();

			// lock expires (t=12_100)
			await vi.advanceTimersByTimeAsync(1100);

			// self-heal
			await expect(limiter.run(task)).resolves.toBeDefined();
			expect(task).toHaveBeenCalledOnce();

			// state recovered with server limits
			const status = await limiter.getStatus();
			expect(status.isUnlimited).toBe(false);
			expect(status.lastKnownRemaining).toBe(9);
			expect(status.lastKnownResetAt).toBe(15_000);
		});
	});
});
