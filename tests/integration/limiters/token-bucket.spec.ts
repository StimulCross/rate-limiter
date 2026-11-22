import type { RateLimiter, RateLimiterOptions } from '../../../src/index.js'
import type { TokenBucketLimitOptions, TokenBucketOptions, TokenBucketStatus } from '../../../src/limiters/token-bucket/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitErrorCode } from '../../../src/index.js'
import { TokenBucketLimiter } from '../../../src/limiters/token-bucket/index.js'

describe('Token Bucket public entry point', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('should charge the initial burst before invocation and refill up to capacity', async () => {
		vi.setSystemTime(0)
		const options: TokenBucketOptions = {
			limitOptions: { capacity: 3, refillRate: 2 },
		}
		const bucket = new TokenBucketLimiter(options)
		const limiter: RateLimiter<TokenBucketStatus> = bucket

		for (const tokens of [2, 1, 0]) {
			const callback = vi.fn(async () => await bucket.getStatus())
			const result = limiter.run(callback)
			expect(callback).toHaveBeenCalledOnce()

			await expect(result).resolves.toEqual({
				nextAvailableAt: tokens === 0
					? 500
					: 0,
				profiles: [
					{ capacity: 3, refillRate: 2, tokens },
				],
			})
		}

		vi.setSystemTime(499)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1,
		})

		vi.setSystemTime(500)
		await limiter.run(() => {})

		vi.setSystemTime(10_000)

		for (let index = 0; index < 3; index++)
			await limiter.run(() => {})

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 500,
		})

		await expect(limiter.run(() => 'other key', { key: 'other' })).resolves.toBe('other key')
		await limiter.clear()
		const cleared = await bucket.getStatus()
		expect(cleared.profiles[0]?.tokens).toBe(3)
	})

	it('should retain accumulated partial refill through successive charges', async () => {
		vi.setSystemTime(0)
		const limiter = new TokenBucketLimiter({
			limitOptions: { capacity: 5, refillRate: 2 },
		})

		for (const time of [0, 1, 2, 3, 4]) {
			vi.setSystemTime(time)
			await limiter.run(() => {})
		}

		vi.setSystemTime(499)
		const status = await limiter.getStatus()
		expect(status.profiles[0]?.tokens).toBe(0.998)
		expect(status.nextAvailableAt).toBe(500)

		vi.setSystemTime(500)
		await expect(limiter.run(() => 'refilled')).resolves.toBe('refilled')
	})

	it('should preserve the ready profile when another denies the start and charge both at the next start', async () => {
		vi.setSystemTime(0)
		const limiter = new TokenBucketLimiter({
			limitOptions: [
				{ capacity: 2, refillRate: 2 },
				{ capacity: 3, refillRate: 1 },
			],
		})

		for (const time of [0, 0, 500, 1000]) {
			vi.setSystemTime(time)
			await limiter.run(() => {})
		}

		vi.setSystemTime(1500)
		const blocked = vi.fn()

		await expect(limiter.run(blocked)).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 500,
		})

		expect(blocked).not.toHaveBeenCalled()

		expect(await limiter.getStatus()).toEqual({
			nextAvailableAt: 2000,
			profiles: [
				{ capacity: 2, refillRate: 2, tokens: 1 },
				{ capacity: 3, refillRate: 1, tokens: 0.5 },
			],
		})

		vi.setSystemTime(2000)
		await limiter.run(() => {})
		const { profiles } = await limiter.getStatus()
		expect(profiles.map(profile => profile.tokens)).toEqual([1, 0])
	})

	it('should wake queued work when the slowest profile refills and retain fractional tokens', async () => {
		vi.useFakeTimers({ now: 0 })
		const limiter = new TokenBucketLimiter({
			limitOptions: [
				{ capacity: 2, refillRate: 2 },
				{ capacity: 2, refillRate: 2.5 },
			],
			limitBehavior: 'enqueue',
			queue: { capacity: 1 },
		})

		try {
			await limiter.run(() => {})
			await limiter.run(() => {})
			const callback = vi.fn(() => Date.now())
			const waiting = limiter.run(callback)
			await vi.advanceTimersByTimeAsync(499)
			expect(callback).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(1)
			await expect(waiting).resolves.toBe(500)
			expect(callback).toHaveBeenCalledOnce()
			const { profiles } = await limiter.getStatus()
			expect(profiles[1]?.tokens).toBe(0.25)
			expect(vi.getTimerCount()).toBe(0)
		}
		finally {
			await limiter.destroy()
			vi.useRealTimers()
		}
	})

	it('should project fractional refill without changing the stored balance or advancing the watermark', async () => {
		vi.setSystemTime(0)
		const limiter = new TokenBucketLimiter({
			limitOptions: { capacity: 1, refillRate: 1 },
		})
		const failure = new Error('callback failed')

		await expect(limiter.run(() => {
			throw failure
		})).rejects.toBe(failure)

		vi.setSystemTime(1000)
		const full = await limiter.getStatus()
		expect(full.profiles[0]?.tokens).toBe(1)
		vi.setSystemTime(250)

		expect(await limiter.getStatus()).toEqual({
			nextAvailableAt: 1000,
			profiles: [
				{ capacity: 1, refillRate: 1, tokens: 0.25 },
			],
		})

		await expect(limiter.run(() => {})).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })

		vi.setSystemTime(100)
		const rolledBack = await limiter.getStatus()
		expect(rolledBack.profiles[0]?.tokens).toBe(0.25)
	})

	it('should retain a future wake timestamp when the refill interval is below clock precision', async () => {
		const start = 2 ** 52
		vi.setSystemTime(start)
		const limiter = new TokenBucketLimiter({
			limitOptions: { capacity: 1, refillRate: 2000 },
		})
		await limiter.run(() => {})
		const status = await limiter.getStatus()
		expect(status.nextAvailableAt).toBe(start + 1)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1,
		})

		vi.setSystemTime(start + 1)
		await expect(limiter.run(() => 'refilled')).resolves.toBe('refilled')
	})

	it.each<{ limitOptions: TokenBucketLimitOptions | readonly TokenBucketLimitOptions[] }>([
		{ limitOptions: [] },
		{
			limitOptions: { capacity: 0, refillRate: 1 },
		},
		{
			limitOptions: { capacity: 1.5, refillRate: 1 },
		},
		{
			limitOptions: { capacity: 1, refillRate: 0 },
		},
		{
			limitOptions: { capacity: 1, refillRate: Infinity },
		},
	])('should reject invalid profile configuration $limitOptions', ({ limitOptions }) => {
		expect(() => new TokenBucketLimiter({ limitOptions })).toThrow(RangeError)
	})

	describe('execution contract', () => {
		function createLimiter(options: RateLimiterOptions) {
			return new TokenBucketLimiter({
				...options,
				limitOptions: { capacity: 1, refillRate: 10 },
			})
		}

		beforeEach(() => {
			vi.useFakeTimers({
				now: 0,
				toFake: [
					'Date',
					'performance',
					'setTimeout',
					'clearTimeout',
				],
			})
		})

		describe('admission and waiting', () => {
			it('should honor a per-task admission mode without changing the instance default', async () => {
				const limiter = createLimiter({
					queue: { capacity: 1 },
				})
				const rejected = vi.fn()
				const queued = vi.fn(Date.now)

				await limiter.run(Date.now)

				await expect(limiter.run(rejected)).rejects.toMatchObject({
					code: RateLimitErrorCode.LimitExceeded,
					retryAfterMs: 100,
				})

				const pending = limiter.run(queued, { limitBehavior: 'enqueue' })
				const settled = Promise.allSettled([pending])

				try {
					await expect(limiter.run(rejected)).rejects.toMatchObject({
						code: RateLimitErrorCode.LimitExceeded,
						retryAfterMs: 100,
					})

					await vi.advanceTimersByTimeAsync(99)
					expect(queued).not.toHaveBeenCalled()
					await vi.advanceTimersByTimeAsync(1)
					await expect(pending).resolves.toBe(100)
					expect(queued).toHaveBeenCalledOnce()
					expect(rejected).not.toHaveBeenCalled()
				}
				finally {
					await limiter.destroy()
					await settled
				}
			})

			it('should reject a pre-aborted submission and leave its key ready for the next run', async () => {
				const limiter = createLimiter({})
				const callback = vi.fn(Date.now)

				await expect(limiter.run(callback, {
					signal: AbortSignal.abort(),
				})).rejects.toMatchObject({
					code: RateLimitErrorCode.Cancelled,
				})

				expect(callback).not.toHaveBeenCalled()
				await expect(limiter.run(callback)).resolves.toBe(0)
				expect(callback).toHaveBeenCalledOnce()
			})

			it('should release a queue place after abort without changing the next quota boundary', async () => {
				const limiter = createLimiter({
					limitBehavior: 'enqueue',
					queue: { capacity: 1 },
				})
				await limiter.run(Date.now)
				const controller = new AbortController()
				const callback = vi.fn(Date.now)
				const cancelled = limiter.run(callback, { signal: controller.signal })
				const rejected = expect(cancelled).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

				controller.abort()
				const replacement = limiter.run(Date.now)
				const settled = Promise.allSettled([replacement])

				try {
					await rejected
					await vi.advanceTimersByTimeAsync(100)
					await expect(replacement).resolves.toBe(100)
					expect(callback).not.toHaveBeenCalled()
				}
				finally {
					await limiter.destroy()
					await settled
				}
			})

			it('should apply the default deadline and let a per-task override wait for quota', async () => {
				const limiter = createLimiter({
					limitBehavior: 'enqueue',
					queue: { capacity: 2, maxWaitMs: 50 },
				})
				await limiter.run(Date.now)
				const shortCallback = vi.fn(Date.now)
				const longCallback = vi.fn(Date.now)
				const short = limiter.run(shortCallback)
				const long = limiter.run(longCallback, { maxWaitMs: 125 })
				const settled = Promise.allSettled([short, long])

				try {
					const shortRejected = vi.fn()
					void short.catch(shortRejected)

					await expect(limiter.run(shortCallback, { maxWaitMs: 200 })).rejects.toMatchObject({
						code: RateLimitErrorCode.QueueOverflow,
					})

					await vi.advanceTimersByTimeAsync(49)
					expect(shortRejected).not.toHaveBeenCalled()

					await vi.advanceTimersByTimeAsync(1)
					await expect(short).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
					expect(shortCallback).not.toHaveBeenCalled()
					expect(longCallback).not.toHaveBeenCalled()

					await vi.advanceTimersByTimeAsync(50)
					await expect(long).resolves.toBe(100)
					expect(longCallback).toHaveBeenCalledOnce()
				}
				finally {
					await limiter.destroy()
					await settled
				}
			})
		})

		describe('lifecycle', () => {
			it('should clear one key with its waiter and preserve the other key until instance clear', async () => {
				const limiter = createLimiter({
					limitBehavior: 'enqueue',
					queue: { capacity: 2 },
				})
				const otherInstance = createLimiter({})
				await limiter.run(Date.now, { key: 'A' })
				await expect(otherInstance.run(Date.now, { key: 'A' })).resolves.toBe(0)
				await limiter.run(Date.now, { key: 'B' })
				const callbackA = vi.fn(Date.now)
				const callbackB = vi.fn(Date.now)
				const waitingA = limiter.run(callbackA, { key: 'A' })
				const waitingB = limiter.run(callbackB, { key: 'B' })
				const settled = Promise.allSettled([waitingA, waitingB])
				const waitingBRejected = vi.fn()
				void waitingB.catch(waitingBRejected)

				try {
					await limiter.clear('A')
					await expect(waitingA).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })
					await expect(limiter.run(Date.now, { key: 'A', limitBehavior: 'reject' })).resolves.toBe(0)

					await expect(limiter.run(Date.now, { key: 'B', limitBehavior: 'reject' })).rejects.toMatchObject({
						code: RateLimitErrorCode.LimitExceeded,
						retryAfterMs: 100,
					})

					expect(waitingBRejected).not.toHaveBeenCalled()

					await limiter.clear()
					await expect(waitingB).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })
					await expect(limiter.run(Date.now, { key: 'A', limitBehavior: 'reject' })).resolves.toBe(0)
					await expect(limiter.run(Date.now, { key: 'B', limitBehavior: 'reject' })).resolves.toBe(0)

					await expect(otherInstance.run(callbackA, { key: 'A' })).rejects.toMatchObject({
						code: RateLimitErrorCode.LimitExceeded,
					})

					await vi.advanceTimersByTimeAsync(100)
					expect(callbackA).not.toHaveBeenCalled()
					expect(callbackB).not.toHaveBeenCalled()
					expect(vi.getTimerCount()).toBe(0)
				}
				finally {
					await limiter.destroy()
					await otherInstance.destroy()
					await settled
				}
			})

			it('should reject waiting and new work on destroy and await the running callback', async () => {
				const limiter = createLimiter({
					limitBehavior: 'enqueue',
					queue: { capacity: 1, concurrency: 1 },
				})
				const hold = Promise.withResolvers<number>()
				const running = limiter.run(async () => await hold.promise, { key: 'A' })
				const callback = vi.fn(Date.now)
				const waiting = limiter.run(callback, { key: 'B', maxWaitMs: 50 })
				const rejected = expect(waiting).rejects.toMatchObject({ code: RateLimitErrorCode.Destroyed })
				const finished = vi.fn()
				const shutdown = limiter.destroy().then(finished)

				try {
					await rejected
					await expect(limiter.run(callback, { key: 'C' })).rejects.toMatchObject({ code: RateLimitErrorCode.Destroyed })
					expect(finished).not.toHaveBeenCalled()
					expect(callback).not.toHaveBeenCalled()
					expect(vi.getTimerCount()).toBe(0)
				}
				finally {
					hold.resolve(42)
					await shutdown
				}

				await expect(running).resolves.toBe(42)
				expect(finished).toHaveBeenCalledOnce()
			})
		})
	})
})
