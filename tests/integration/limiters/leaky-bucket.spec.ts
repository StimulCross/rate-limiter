import type { RateLimiterOptions } from '../../../src/index.js'
import { LogLevel } from '@stimulcross/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitErrorCode } from '../../../src/index.js'
import { LeakyBucketLimiter } from '../../../src/limiters/leaky-bucket/index.js'

describe('Leaky Bucket', () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('should project status without recording elapsed quota time and preserve a failed start', async () => {
		vi.setSystemTime(0)
		const limiter = new LeakyBucketLimiter({
			limitOptions: { intervalMs: 100 },
		})
		const failure = new Error('callback failed')

		expect(await limiter.getStatus()).toEqual({ intervalMs: 100, lastStartedAt: null, nextAvailableAt: 0 })

		await expect(limiter.run(() => {
			throw failure
		})).rejects.toBe(failure)

		expect(await limiter.getStatus()).toEqual({ intervalMs: 100, lastStartedAt: 0, nextAvailableAt: 100 })

		vi.setSystemTime(150)
		expect(await limiter.getStatus()).toEqual({ intervalMs: 100, lastStartedAt: 0, nextAvailableAt: 150 })
		vi.setSystemTime(50)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 50,
		})

		vi.setSystemTime(100)

		await expect(limiter.run(async () => await limiter.getStatus())).resolves.toEqual({
			intervalMs: 100,
			lastStartedAt: 100,
			nextAvailableAt: 200,
		})
	})

	it('should block an overflowing key until clear without blocking other keys', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_VALUE)
		const limiter = new LeakyBucketLimiter({
			limitOptions: { intervalMs: Number.MIN_VALUE },
		})

		await limiter.run(() => {}, { key: 'A' })
		expect(await limiter.getStatus('A')).toMatchObject({ lastStartedAt: Number.MAX_VALUE, nextAvailableAt: Infinity })

		await expect(limiter.run(() => {}, { key: 'A' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: null,
		})

		await expect(limiter.run(() => 'independent', { key: 'B' })).resolves.toBe('independent')

		await limiter.clear('A')
		expect(await limiter.getStatus('A')).toMatchObject({ lastStartedAt: null, nextAvailableAt: Number.MAX_VALUE })
		expect(await limiter.getStatus('B')).toMatchObject({ lastStartedAt: Number.MAX_VALUE, nextAvailableAt: Infinity })
		await expect(limiter.run(() => 'reset', { key: 'A' })).resolves.toBe('reset')
	})

	it('should pace waiters from a late timer wakeup and log each committed queue transition', async () => {
		vi.useFakeTimers({ now: 0 })
		const output = vi.fn()
		const limiter = new LeakyBucketLimiter({
			limitOptions: { intervalMs: 100 },
			limitBehavior: 'enqueue',
			queue: { capacity: 2, concurrency: 2 },
			loggerOptions: { minLevel: 'debug', includeIdentifiers: true, custom: output },
		})
		const hold = Promise.withResolvers<undefined>()
		const first = limiter.run(async () => await hold.promise, { id: 'first', key: 'A' })
		const second = limiter.run(Date.now, { id: 'second', key: 'A' })
		const thirdCallback = vi.fn(Date.now)
		const third = limiter.run(thirdCallback, { id: 'third', key: 'A' })

		try {
			// The scheduled wakeup still fires after 100 ms of elapsed time.
			vi.setSystemTime(900)
			await vi.advanceTimersByTimeAsync(100)
			await expect(second).resolves.toBe(1000)
			expect(thirdCallback).not.toHaveBeenCalled()
			expect(await limiter.getStatus('A')).toEqual({ intervalMs: 100, lastStartedAt: 1000, nextAvailableAt: 1100 })

			await vi.advanceTimersByTimeAsync(99)
			expect(thirdCallback).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			await expect(third).resolves.toBe(1100)

			expect(output.mock.calls).toEqual([
				[LogLevel.DEBUG, '[TASK STARTED] id="first" key="A" | source=immediate priority=Normal waiting=0 active=1'],
				[LogLevel.DEBUG, '[TASK QUEUED] id="second" key="A" | priority=Normal waiting=1 capacity=2'],
				[LogLevel.DEBUG, '[TASK QUEUED] id="third" key="A" | priority=Normal waiting=2 capacity=2'],
				[LogLevel.DEBUG, '[TASK STARTED] id="second" key="A" | source=queue priority=Normal waiting=1 active=2'],
				[LogLevel.DEBUG, '[TASK STARTED] id="third" key="A" | source=queue priority=Normal waiting=0 active=2'],
			])
		}
		finally {
			const settled = Promise.allSettled([first, second, third])
			hold.resolve(undefined)
			await limiter.destroy()
			await settled
		}
	})

	it('should pace several waiters from a delayed release of the only slot', async () => {
		vi.useFakeTimers({ now: 0 })
		const limiter = new LeakyBucketLimiter({
			limitOptions: { intervalMs: 100 },
			limitBehavior: 'enqueue',
			queue: { capacity: 2, concurrency: 1 },
		})
		const hold = Promise.withResolvers<undefined>()
		const first = limiter.run(async () => await hold.promise)
		const secondCallback = vi.fn(() => Date.now())
		const thirdCallback = vi.fn(() => Date.now())
		const second = limiter.run(secondCallback)
		const third = limiter.run(thirdCallback)

		try {
			await vi.advanceTimersByTimeAsync(500)
			expect(secondCallback).not.toHaveBeenCalled()
			hold.resolve(undefined)
			await expect(second).resolves.toBe(500)
			await vi.advanceTimersByTimeAsync(99)
			expect(thirdCallback).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			await expect(third).resolves.toBe(600)
		}
		finally {
			const settled = Promise.allSettled([first, second, third])
			hold.resolve(undefined)
			await limiter.destroy()
			await settled
		}
	})

	it('should preserve the last start through cancellation and expiry and reset history on clear', async () => {
		vi.useFakeTimers({ now: 0, toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
		const limiter = new LeakyBucketLimiter({
			limitOptions: { intervalMs: 100 },
			limitBehavior: 'enqueue',
			queue: { capacity: 2 },
		})
		const controller = new AbortController()
		const callback = vi.fn()

		try {
			await limiter.run(() => {}, { key: 'A' })
			const cancelled = limiter.run(callback, { key: 'A', signal: controller.signal })
			controller.abort()
			await expect(cancelled).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

			const expiring = limiter.run(callback, { key: 'A', maxWaitMs: 50 })
			const expired = expect(expiring).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
			await vi.advanceTimersByTimeAsync(50)
			await expired
			await expect(limiter.run(() => Date.now(), { key: 'B' })).resolves.toBe(50)
			expect(await limiter.getStatus('A')).toMatchObject({ lastStartedAt: 0, nextAvailableAt: 100 })

			const waiting = limiter.run(callback, { key: 'A' })
			const cleared = expect(waiting).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })
			await limiter.clear('A')
			await cleared
			expect(await limiter.getStatus('A')).toMatchObject({ lastStartedAt: null, nextAvailableAt: 50 })
			expect(await limiter.getStatus('B')).toMatchObject({ lastStartedAt: 50, nextAvailableAt: 150 })
			expect(callback).not.toHaveBeenCalled()
		}
		finally {
			await limiter.destroy()
		}
	})

	describe('execution contract', () => {
		function createLimiter(options: RateLimiterOptions) {
			return new LeakyBucketLimiter({
				...options,
				limitOptions: { intervalMs: 100 },
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
