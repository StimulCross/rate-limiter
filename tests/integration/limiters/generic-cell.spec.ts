import type { RateLimiter, RateLimiterOptions } from '../../../src/index.js'
import type { GenericCellOptions, GenericCellStatus } from '../../../src/limiters/generic-cell/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitErrorCode } from '../../../src/index.js'
import { GenericCellLimiter } from '../../../src/limiters/generic-cell/index.js'

describe('Generic Cell public entry point', () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('should enforce spacing from each actual start with a burst of one', async () => {
		vi.setSystemTime(0)
		const options: GenericCellOptions = {
			limitOptions: { intervalMs: 100, burst: 1 },
		}
		const cell = new GenericCellLimiter(options)
		const limiter: RateLimiter<GenericCellStatus> = cell
		const failure = new Error('callback failure')

		await expect(limiter.run(() => {
			throw failure
		})).rejects.toBe(failure)

		vi.setSystemTime(99)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1,
		})

		vi.setSystemTime(100)
		await expect(limiter.run(() => 'at the boundary')).resolves.toBe('at the boundary')

		vi.setSystemTime(250)
		const callback = vi.fn(async () => await cell.getStatus())
		const result = limiter.run(callback)
		expect(callback).toHaveBeenCalledOnce()

		await expect(result).resolves.toEqual({
			nextAvailableAt: 350,
			profiles: [
				{
					intervalMs: 100,
					burst: 1,
					tat: 350,
					remaining: 0,
				},
			],
		})
	})

	it('should allow a bounded burst initially and after a long idle period', async () => {
		vi.setSystemTime(0)
		const limiter = new GenericCellLimiter({
			limitOptions: { intervalMs: 100, burst: 3 },
		})

		for (const time of [0, 10_000]) {
			vi.setSystemTime(time)

			for (const remaining of [2, 1, 0]) {
				await limiter.run(() => {})
				const { profiles } = await limiter.getStatus()
				expect(profiles[0]?.remaining).toBe(remaining)
			}

			vi.setSystemTime(time + 99)

			await expect(limiter.run(() => {})).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
				retryAfterMs: 1,
			})

			vi.setSystemTime(time + 100)
			await expect(limiter.run(() => 'one interval later')).resolves.toBe('one interval later')
		}
	})

	it('should keep both profiles intact when one denies admission and isolate other keys', async () => {
		vi.setSystemTime(0)
		const limiter = new GenericCellLimiter({
			limitOptions: [
				{ intervalMs: 100, burst: 1 },
				{ intervalMs: 1000, burst: 2 },
			],
		})

		await limiter.run(() => {}, { key: 'A' })
		vi.setSystemTime(100)
		await limiter.run(() => {}, { key: 'A' })
		vi.setSystemTime(200)
		const callback = vi.fn()

		await expect(limiter.run(callback, { key: 'A' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 800,
		})

		expect(callback).not.toHaveBeenCalled()

		expect(await limiter.getStatus('A')).toEqual({
			nextAvailableAt: 1000,
			profiles: [
				{
					intervalMs: 100,
					burst: 1,
					tat: 200,
					remaining: 1,
				},
				{
					intervalMs: 1000,
					burst: 2,
					tat: 2000,
					remaining: 0,
				},
			],
		})

		await expect(limiter.run(() => 'other key', { key: 'B' })).resolves.toBe('other key')

		vi.setSystemTime(1000)
		await limiter.run(() => {}, { key: 'A' })
		const charged = await limiter.getStatus('A')
		expect(charged.profiles.map(profile => profile.tat)).toEqual([1100, 3000])

		await limiter.clear('A')
		const cleared = await limiter.getStatus('A')
		const otherKey = await limiter.getStatus('B')
		expect(cleared.profiles.map(profile => profile.tat)).toEqual([null, null])
		expect(otherKey.profiles.map(profile => profile.tat)).toEqual([300, 1200])
	})

	it('should project recovery without changing TAT or the clock watermark', async () => {
		vi.setSystemTime(0)
		const limiter = new GenericCellLimiter({
			limitOptions: { intervalMs: 100, burst: 1 },
		})
		await limiter.run(() => {})

		vi.setSystemTime(100)

		const recovered = await limiter.getStatus()

		expect(recovered.profiles[0]).toEqual({
			intervalMs: 100,
			burst: 1,
			tat: 100,
			remaining: 1,
		})

		vi.setSystemTime(50)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 50,
		})
	})

	it('should wake at the latest profile boundary without charging a cancelled waiter', async () => {
		vi.useFakeTimers({ now: 0 })
		const limiter = new GenericCellLimiter({
			limitOptions: [
				{ intervalMs: 100, burst: 1 },
				{ intervalMs: 200, burst: 1 },
			],
			limitBehavior: 'enqueue',
			queue: { capacity: 2 },
		})

		try {
			await limiter.run(() => {})
			const controller = new AbortController()
			const cancelled = vi.fn()
			const pending = limiter.run(cancelled, { signal: controller.signal })
			const callback = vi.fn(() => Date.now())
			const waiting = limiter.run(callback)
			controller.abort()
			await expect(pending).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

			await vi.advanceTimersByTimeAsync(199)
			expect(callback).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			await expect(waiting).resolves.toBe(200)
			expect(cancelled).not.toHaveBeenCalled()
			const { nextAvailableAt } = await limiter.getStatus()
			expect(nextAvailableAt).toBe(400)
		}
		finally {
			await limiter.destroy()
			vi.useRealTimers()
		}
	})

	it('should retain exact accumulated intervals beyond the safe integer timestamp range', async () => {
		const start = 2 ** 53
		const epoch = vi.spyOn(Date, 'now').mockReturnValue(start)
		const limiter = new GenericCellLimiter({
			limitOptions: { intervalMs: 1, burst: 3 },
		})

		for (let index = 0; index < 3; index++)
			await limiter.run(() => {})

		const status = await limiter.getStatus()
		expect(status.nextAvailableAt).toBe(start + 2)
		expect(status.profiles[0]?.tat).toBe(start + 4)
		await expect(limiter.run(() => {})).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })

		epoch.mockReturnValue(start + 2)
		const recovered = await limiter.getStatus()
		expect(recovered.profiles[0]?.remaining).toBe(2)
		await limiter.run(() => {})
		await limiter.run(() => {})
		await expect(limiter.run(() => {})).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
	})

	it('should retain the fractional phase of a start when its next boundary rounds down', async () => {
		const epoch = vi.spyOn(Date, 'now').mockReturnValue(Number.MIN_VALUE)
		const limiter = new GenericCellLimiter({
			limitOptions: { intervalMs: 1, burst: 1 },
		})
		await limiter.run(() => {})
		epoch.mockReturnValue(1)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: Number.EPSILON,
		})

		epoch.mockReturnValue(1 + Number.EPSILON)
		await expect(limiter.run(() => 'after the boundary')).resolves.toBe('after the boundary')
	})

	it.each<Pick<GenericCellOptions, 'limitOptions'>>([
		{ limitOptions: [] },
		{
			limitOptions: { intervalMs: 0, burst: 1 },
		},
		{
			limitOptions: { intervalMs: 1.5, burst: 1 },
		},
		{
			limitOptions: { intervalMs: Infinity, burst: 1 },
		},
		{
			limitOptions: { intervalMs: 1, burst: 0 },
		},
		{
			limitOptions: { intervalMs: 1, burst: 2 ** 53 },
		},
	])('should reject invalid profile configuration $limitOptions', ({ limitOptions }) => {
		expect(() => new GenericCellLimiter({ limitOptions })).toThrow(RangeError)
	})

	describe('execution contract', () => {
		function createLimiter(options: RateLimiterOptions) {
			return new GenericCellLimiter({
				...options,
				limitOptions: { intervalMs: 100, burst: 1 },
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
