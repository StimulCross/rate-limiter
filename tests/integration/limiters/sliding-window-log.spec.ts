import type { RateLimiter, RateLimiterOptions } from '../../../src/index.js'
import type { SlidingWindowLogOptions, SlidingWindowLogStatus } from '../../../src/limiters/sliding-window-log/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitErrorCode } from '../../../src/index.js'
import { SlidingWindowLogLimiter } from '../../../src/limiters/sliding-window-log/index.js'

describe('Sliding Window Log public entry point', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('should record each start at timestamp zero and release both places at the exact boundary', async () => {
		vi.setSystemTime(0)
		const options: SlidingWindowLogOptions = {
			limitOptions: { limit: 2, windowMs: 1000 },
		}
		const log = new SlidingWindowLogLimiter(options)
		const limiter: RateLimiter<SlidingWindowLogStatus> = log

		await limiter.run(() => {})
		const callback = vi.fn(async () => await log.getStatus())
		const result = limiter.run(callback)
		expect(callback).toHaveBeenCalledOnce()

		await expect(result).resolves.toEqual({
			nextAvailableAt: 1000,
			profiles: [
				{
					limit: 2,
					windowMs: 1000,
					used: 2,
					remaining: 0,
				},
			],
		})

		vi.setSystemTime(999)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1,
		})

		vi.setSystemTime(1000)

		const expired = await log.getStatus()
		expect(expired.profiles[0]?.remaining).toBe(2)
		await limiter.run(() => {})
		await limiter.run(() => {})

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1000,
		})
	})

	it('should restore capacity one start at a time as staggered entries expire', async () => {
		vi.setSystemTime(0)
		const limiter = new SlidingWindowLogLimiter({
			limitOptions: { limit: 2, windowMs: 100 },
		})
		await limiter.run(Date.now)
		vi.setSystemTime(30)
		await limiter.run(Date.now)
		vi.setSystemTime(99)

		await expect(limiter.run(Date.now)).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1,
		})

		vi.setSystemTime(100)
		await expect(limiter.run(Date.now)).resolves.toBe(100)

		await expect(limiter.run(Date.now)).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 30,
		})

		vi.setSystemTime(130)
		await expect(limiter.run(Date.now)).resolves.toBe(130)
		await expect(limiter.getStatus()).resolves.toMatchObject({ nextAvailableAt: 200 })
	})

	it('should retain history needed by longer windows and record nothing when one profile denies admission', async () => {
		vi.setSystemTime(0)
		const limiter = new SlidingWindowLogLimiter({
			limitOptions: [
				{ limit: 2, windowMs: 1000 },
				{ limit: 3, windowMs: 60_000 },
			],
		})

		for (const time of [0, 100, 1000]) {
			vi.setSystemTime(time)
			await limiter.run(() => {}, { key: 'A' })
		}

		vi.setSystemTime(1100)

		const blocked = vi.fn()

		await expect(limiter.run(blocked, { key: 'A' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 58_900,
		})

		expect(blocked).not.toHaveBeenCalled()

		expect(await limiter.getStatus('A')).toEqual({
			nextAvailableAt: 60_000,
			profiles: [
				{
					limit: 2,
					windowMs: 1000,
					used: 1,
					remaining: 1,
				},
				{
					limit: 3,
					windowMs: 60_000,
					used: 3,
					remaining: 0,
				},
			],
		})

		await expect(limiter.run(() => 'other key', { key: 'B' })).resolves.toBe('other key')

		vi.setSystemTime(60_000)

		await limiter.run(() => {}, { key: 'A' })
		const { nextAvailableAt, profiles } = await limiter.getStatus('A')
		expect(nextAvailableAt).toBe(60_100)
		expect(profiles.map(profile => profile.used)).toEqual([1, 3])
	})

	it('should project expiry without pruning history or advancing the key watermark', async () => {
		vi.setSystemTime(0)
		const limiter = new SlidingWindowLogLimiter({
			limitOptions: { limit: 1, windowMs: 1000 },
		})
		await limiter.run(() => {})

		vi.setSystemTime(1000)

		const elapsed = await limiter.getStatus()
		expect(elapsed.profiles[0]?.used).toBe(0)

		vi.setSystemTime(500)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 500,
		})

		const rolledBack = await limiter.getStatus()
		expect(rolledBack.profiles[0]?.used).toBe(1)
	})

	it('should wake at the later window boundary and retain charges only for actual starts', async () => {
		vi.useFakeTimers({ now: 0 })
		const limiter = new SlidingWindowLogLimiter({
			limitOptions: [
				{ limit: 1, windowMs: 100 },
				{ limit: 1, windowMs: 200 },
			],
			limitBehavior: 'enqueue',
			queue: { capacity: 2 },
		})

		try {
			await limiter.run(() => {})
			const controller = new AbortController()
			const cancelled = vi.fn()
			const pending = limiter.run(cancelled, { signal: controller.signal })
			controller.abort()
			await expect(pending).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

			const callback = vi.fn(() => Date.now())
			const waiting = limiter.run(callback)
			await vi.advanceTimersByTimeAsync(199)
			expect(callback).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(1)
			await expect(waiting).resolves.toBe(200)
			expect(cancelled).not.toHaveBeenCalled()

			const status = await limiter.getStatus()
			expect(status.nextAvailableAt).toBe(400)
			expect(status.profiles.map(profile => profile.used)).toEqual([1, 1])
		}
		finally {
			await limiter.destroy()
			vi.useRealTimers()
		}
	})

	it.each([
		{ windowMs: 0.25, delay: 1 },
		{ windowMs: 1.25, delay: 2 },
	])('should expire a fractional window at the first representable time after its boundary', async ({ windowMs, delay }) => {
		const start = 2 ** 52
		vi.setSystemTime(start)
		const limiter = new SlidingWindowLogLimiter({
			limitOptions: { limit: 1, windowMs },
		})
		await limiter.run(() => {})

		vi.setSystemTime(start + delay - 1)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1,
		})

		vi.setSystemTime(start + delay)
		await expect(limiter.run(() => 'next timestamp')).resolves.toBe('next timestamp')
	})

	it.each<Pick<SlidingWindowLogOptions, 'limitOptions'>>([
		{ limitOptions: [] },
		{
			limitOptions: { limit: 0, windowMs: 1 },
		},
		{
			limitOptions: { limit: 1.5, windowMs: 1 },
		},
		{
			limitOptions: { limit: 1, windowMs: 0 },
		},
		{
			limitOptions: { limit: 1, windowMs: Infinity },
		},
	])('should reject invalid profile configuration $limitOptions', ({ limitOptions }) => {
		expect(() => new SlidingWindowLogLimiter({ limitOptions })).toThrow(RangeError)
	})

	describe('execution contract', () => {
		function createLimiter(options: RateLimiterOptions) {
			return new SlidingWindowLogLimiter({
				...options,
				limitOptions: { limit: 1, windowMs: 100 },
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
