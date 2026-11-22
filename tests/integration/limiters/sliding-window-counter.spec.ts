import type { RateLimiterOptions } from '../../../src/index.js'
import { LogLevel } from '@stimulcross/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitErrorCode } from '../../../src/index.js'
import { SlidingWindowCounterLimiter } from '../../../src/limiters/sliding-window-counter/index.js'
import { SlidingWindowLogLimiter } from '../../../src/limiters/sliding-window-log/index.js'

describe('Sliding Window Counter', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('should wake a queued callback at the reported threshold and log the queue transitions', async () => {
		vi.useFakeTimers({ now: 990 })
		const output = vi.fn()
		const callback = vi.fn(() => Date.now())
		const limiter = new SlidingWindowCounterLimiter({
			limitOptions: { limit: 3, windowMs: 999 },
			limitBehavior: 'enqueue',
			queue: { capacity: 1 },
			loggerOptions: { minLevel: 'debug', includeIdentifiers: true, custom: output },
		})

		let settled: Promise<unknown> | undefined

		try {
			for (let count = 0; count < 3; count++)
				await limiter.run(() => {}, { key: 'A' })

			await vi.advanceTimersByTimeAsync(110)
			output.mockClear()
			const queued = limiter.run(callback, { id: 'waiter', key: 'A' })
			settled = Promise.allSettled([queued])

			expect(await limiter.getStatus('A')).toMatchObject({ nextAvailableAt: 1332, remaining: 0 })
			expect(callback).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(231)
			expect(callback).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			expect(callback).toHaveBeenCalledExactlyOnceWith()
			await expect(queued).resolves.toBe(1332)

			expect(await limiter.getStatus('A')).toMatchObject({
				windowStart: 999,
				currentCount: 1,
				previousCount: 3,
				nextAvailableAt: 1665,
			})

			expect(output.mock.calls).toEqual([
				[LogLevel.DEBUG, '[TASK QUEUED] id="waiter" key="A" | priority=Normal waiting=1 capacity=1'],
				[LogLevel.DEBUG, '[TASK STARTED] id="waiter" key="A" | source=queue priority=Normal waiting=0 active=1'],
			])
		}
		finally {
			await limiter.destroy()
			await settled
		}
	})

	it('should charge a slot waiter to the actual start window on the offset grid', async () => {
		vi.setSystemTime(1200)
		const limiter = new SlidingWindowCounterLimiter({
			limitOptions: { limit: 5, windowMs: 1000, offsetMs: 250 },
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		const hold = Promise.withResolvers<undefined>()
		const first = limiter.run(async () => await hold.promise, { key: 'A' })
		const callback = vi.fn(async () => await limiter.getStatus('A'))
		const second = limiter.run(callback, { key: 'A' })
		const settled = Promise.allSettled([first, second])

		try {
			expect(callback).not.toHaveBeenCalled()
			expect(await limiter.getStatus('A')).toMatchObject({ windowStart: 250, currentCount: 1, previousCount: 0 })
			vi.setSystemTime(1250)
			hold.resolve(undefined)
			await expect(second).resolves.toMatchObject({ windowStart: 1250, currentCount: 1, previousCount: 1 })
			expect(await limiter.getStatus('B')).toMatchObject({ currentCount: 0, previousCount: 0, remaining: 5 })
		}
		finally {
			hold.resolve(undefined)
			await limiter.destroy()
			await settled
		}
	})

	it('should keep the watermark unchanged during status projection and admit according to the estimate', async () => {
		vi.setSystemTime(990)
		const options = {
			limitOptions: { limit: 5, windowMs: 1000 },
		}
		const counter = new SlidingWindowCounterLimiter(options)
		const log = new SlidingWindowLogLimiter(options)

		try {
			for (let count = 0; count < 5; count++) {
				await counter.run(() => {})
				await log.run(() => {})
			}

			vi.setSystemTime(1200)
			expect(await counter.getStatus()).toMatchObject({ estimatedCount: 4, remaining: 1, nextAvailableAt: 1200 })
			vi.setSystemTime(1100)
			const callback = vi.fn(() => 'started')

			await expect(counter.run(callback)).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
				retryAfterMs: 100,
			})

			expect(callback).not.toHaveBeenCalled()

			vi.setSystemTime(1500)
			expect(await counter.getStatus()).toMatchObject({ estimatedCount: 2.5, remaining: 2, nextAvailableAt: 1500 })
			await expect(counter.run(callback)).resolves.toBe('started')

			await expect(log.run(callback)).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
				retryAfterMs: 490,
			})

			expect(callback).toHaveBeenCalledTimes(1)
		}
		finally {
			await Promise.all([
				counter.destroy(),
				log.destroy(),
			])
		}
	})

	describe('execution contract', () => {
		function createLimiter(options: RateLimiterOptions) {
			return new SlidingWindowCounterLimiter({
				...options,
				limitOptions: { limit: 1, windowMs: 50 },
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
