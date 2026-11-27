import type { RateLimiter, RateLimiterOptions } from '../../../src/index.js'
import type { FixedWindowOptions, FixedWindowStatus } from '../../../src/limiters/fixed-window/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Priority, RateLimitError, RateLimitErrorCode } from '../../../src/index.js'
import { FixedWindowLimiter } from '../../../src/limiters/fixed-window/index.js'

describe('Fixed Window public entry point', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('should implement the shared contract and expose the committed default-key quota from a callback', async () => {
		vi.setSystemTime(0)
		const options: FixedWindowOptions = {
			limitOptions: { limit: 1, windowMs: 100 },
		}
		const fixed = new FixedWindowLimiter(options)
		const limiter: RateLimiter<FixedWindowStatus> = fixed

		expect(await fixed.getStatus()).toEqual({
			nextAvailableAt: 0,
			profiles: [
				{
					window: null,
					limit: 1,
					used: 0,
					remaining: 1,
				},
			],
		})

		const callback = vi.fn(async () => await fixed.getStatus())
		const result: Promise<FixedWindowStatus> = limiter.run(callback, { maxWaitMs: 0 })
		expect(callback).toHaveBeenCalledOnce()

		await expect(result).resolves.toEqual({
			nextAvailableAt: 100,
			profiles: [
				{
					window: { start: 0, end: 100 },
					limit: 1,
					used: 1,
					remaining: 0,
				},
			],
		})

		const rejection = limiter.run(() => {})
		await expect(rejection).rejects.toBeInstanceOf(RateLimitError)
		await expect(rejection).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded, retryAfterMs: 100 })
		await expect(limiter.run(() => 'other key', { key: 'independent' })).resolves.toBe('other key')
		await limiter.clear()
		const cleared = await fixed.getStatus()
		expect(cleared.profiles[0]?.window).toBeNull()
		await fixed.destroy()
	})

	it('should leave the short profile unopened when a longer profile blocks the key', async () => {
		vi.setSystemTime(100)
		const limiter = new FixedWindowLimiter({
			limitOptions: [
				{ limit: 1, windowMs: 1000 },
				{ limit: 1, windowMs: 5000 },
			] as const,
		})
		await limiter.run(() => {}, { key: 'A' })

		vi.setSystemTime(1200)
		const blocked = vi.fn()

		await expect(limiter.run(blocked, { key: 'A' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 3900,
		})

		expect(blocked).not.toHaveBeenCalled()

		expect(await limiter.getStatus('A')).toEqual({
			nextAvailableAt: 5100,
			profiles: [
				{
					window: null,
					limit: 1,
					used: 0,
					remaining: 1,
				},
				{
					window: { start: 100, end: 5100 },
					limit: 1,
					used: 1,
					remaining: 0,
				},
			],
		})

		vi.setSystemTime(5100)
		await limiter.run(() => {}, { key: 'A' })
		const { profiles } = await limiter.getStatus('A')
		expect(profiles.map(profile => profile.used)).toEqual([1, 1])
		expect(profiles.map(profile => profile.window?.start)).toEqual([5100, 5100])
	})

	it('should allow the complete quota on each side of a shifted grid boundary', async () => {
		vi.setSystemTime(1099)
		const limiter = new FixedWindowLimiter({
			limitOptions: {
				limit: 2,
				windowMs: 1000,
				alignment: 'grid',
				offsetMs: 100,
			},
		})

		for (const timestamp of [1099, 1100]) {
			vi.setSystemTime(timestamp)
			await limiter.run(() => {})
			await limiter.run(() => {})
			await expect(limiter.run(() => {})).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
			const status = await limiter.getStatus()
			expect(status.profiles[0]?.used).toBe(2)
		}

		const status = await limiter.getStatus()
		expect(status.profiles[0]?.window).toEqual({ start: 1100, end: 2100 })
	})

	it('should project elapsed windows without advancing the key watermark', async () => {
		vi.setSystemTime(0)
		const limiter = new FixedWindowLimiter({
			limitOptions: { limit: 1, windowMs: 100 },
		})
		await limiter.run(() => {})
		vi.setSystemTime(150)
		const elapsed = await limiter.getStatus()
		expect(elapsed.profiles[0]?.window).toBeNull()

		vi.setSystemTime(50)

		await expect(limiter.run(() => {})).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 50,
		})

		const observed = await limiter.getStatus()
		expect(observed.profiles[0]?.used).toBe(1)
	})

	describe('weighted scheduling', () => {
		it.each([{}, { priorityMode: 'weighted' }] satisfies RateLimiterOptions[])('should apply the default weighted start shares with options %j', async options => {
			vi.setSystemTime(0)
			const limiter = new FixedWindowLimiter({
				...options,
				limitOptions: { limit: 6, windowMs: 100 },
				limitBehavior: 'enqueue',
				queue: { capacity: 6, concurrency: 1 },
			})
			const hold = Promise.withResolvers<undefined>()
			const running = limiter.run(async () => await hold.promise, { key: 'active' })
			const order: Priority[] = []
			const waiting = [
				Priority.Low,
				Priority.Low,
				Priority.High,
				Priority.High,
				Priority.High,
				Priority.High,
			].map(async priority => await limiter.run(() => order.push(priority), { key: String(priority), priority }))

			hold.resolve(undefined)
			await Promise.all([running, ...waiting])

			expect(order).toEqual([
				Priority.High,
				Priority.High,
				Priority.Low,
				Priority.High,
				Priority.High,
				Priority.Low,
			])
		})

		it.each([{}, { priorityMode: 'weighted' }] satisfies RateLimiterOptions[])('should honor custom weights and preserve diagnostic ids with options %j', async options => {
			vi.setSystemTime(0)
			const generateId = vi.fn(() => 'duplicate')
			const limiter = new FixedWindowLimiter({
				...options,
				limitOptions: { limit: 1, windowMs: 100 },
				limitBehavior: 'enqueue',
				queue: { capacity: 2, concurrency: 1 },
				idGenerator: generateId,
				weights: {
					[Priority.Lowest]: 1,
					[Priority.Low]: 3,
					[Priority.Normal]: 1,
					[Priority.High]: 1,
					[Priority.Highest]: 1,
				},
			})
			const startOrder: string[] = []
			const release = Promise.withResolvers<undefined>()
			const running = limiter.run(async () => await release.promise, { key: 'active', id: 'explicit' })
			const high = limiter.run(() => startOrder.push('high'), { key: 'high', priority: Priority.High })
			const low = limiter.run(() => startOrder.push('low'), { key: 'low', priority: Priority.Low })
			expect(generateId).toHaveBeenCalledTimes(2)

			const blocked = vi.fn()

			await expect(limiter.run(blocked, { key: 'other' })).rejects.toMatchObject({
				code: RateLimitErrorCode.QueueOverflow,
				id: 'duplicate',
			})

			expect(blocked).not.toHaveBeenCalled()
			release.resolve(undefined)
			await Promise.all([running, high, low])
			expect(startOrder).toEqual(['low', 'high'])

			await limiter.destroy()

			await expect(limiter.run(blocked, { id: 'closed' })).rejects.toMatchObject({
				code: RateLimitErrorCode.Destroyed,
				id: 'closed',
			})
		})
	})

	describe('strict priority selection', () => {
		function createLimiter(capacity: number) {
			return new FixedWindowLimiter({
				priorityMode: 'strict',
				limitOptions: { limit: 1, windowMs: 100 },
				limitBehavior: 'enqueue',
				queue: { capacity, concurrency: 1 },
			})
		}

		beforeEach(() => {
			vi.useFakeTimers({ now: 0 })
		})

		it('should reject defined weights at construction and allow undefined weights', async () => {
			const options: FixedWindowOptions = {
				limitOptions: { limit: 1, windowMs: 100 },
				priorityMode: 'strict',
			}

			expect(() => new FixedWindowLimiter({
				...options,
				weights: {
					[Priority.Lowest]: 1,
					[Priority.Low]: 1,
					[Priority.Normal]: 1,
					[Priority.High]: 1,
					[Priority.Highest]: 1,
				},
			})).toThrow(RangeError)

			const limiter = new FixedWindowLimiter({ ...options, weights: undefined })
			await expect(limiter.run(() => 'started')).resolves.toBe('started')
		})

		it('should start Low on a ready key while High waits for quota and prefer High once ready', async () => {
			const limiter = createLimiter(2)
			await limiter.run(() => {}, { key: 'A' })

			const order: string[] = []
			const high = limiter.run(() => order.push('High A'), { key: 'A', priority: Priority.High })
			const hold = Promise.withResolvers<undefined>()
			const running = limiter.run(async () => {
				order.push('Low B')
				await hold.promise
			}, { key: 'B', priority: Priority.Low, maxWaitMs: 0 })
			const low = limiter.run(() => order.push('Low C'), { key: 'C', priority: Priority.Low })

			expect(order).toEqual(['Low B'])
			await vi.advanceTimersByTimeAsync(100)
			expect(order).toEqual(['Low B'])

			hold.resolve(undefined)
			await Promise.all([high, running, low])
			expect(order).toEqual(['Low B', 'High A', 'Low C'])
		})

		it('should preserve cross-key FIFO when the older High regains quota after the younger High was ready', async () => {
			const limiter = createLimiter(2)
			await limiter.run(() => {}, { key: 'A' })

			const hold = Promise.withResolvers<undefined>()
			const running = limiter.run(async () => await hold.promise, { key: 'active' })
			const order: string[] = []
			const older = limiter.run(() => order.push('A'), { key: 'A', priority: Priority.High })
			const younger = limiter.run(() => order.push('B'), { key: 'B', priority: Priority.High })

			await vi.advanceTimersByTimeAsync(100)
			expect(order).toEqual([])
			hold.resolve(undefined)
			await Promise.all([running, older, younger])
			expect(order).toEqual(['A', 'B'])
		})

		it('should start a quota-ready zero-wait High synchronously over a due Low at full capacity', async () => {
			const limiter = createLimiter(1)
			await limiter.run(() => {}, { key: 'A' })
			const low = vi.fn(() => 'older')
			const waiting = limiter.run(low, { key: 'A', priority: Priority.Low })

			// Make A due without executing its pending wakeup callback.
			vi.setSystemTime(100)
			const hold = Promise.withResolvers<string>()
			const high = vi.fn(async () => await hold.promise)
			const immediate = limiter.run(high, { key: 'B', priority: Priority.High, maxWaitMs: 0 })

			expect(high).toHaveBeenCalledOnce()
			expect(low).not.toHaveBeenCalled()
			const statusB = await limiter.getStatus('B')
			const statusA = await limiter.getStatus('A')
			expect(statusB.profiles[0]?.used).toBe(1)
			expect(statusA.profiles[0]?.used).toBe(0)
			hold.resolve('immediate')
			await expect(immediate).resolves.toBe('immediate')
			await expect(waiting).resolves.toBe('older')
		})

		it('should reject a younger zero-wait High at full capacity without charging its key', async () => {
			const limiter = createLimiter(1)
			await limiter.run(() => {}, { key: 'A' })
			const older = vi.fn(() => 'older')
			const waiting = limiter.run(older, { key: 'A', priority: Priority.High })

			vi.setSystemTime(100)
			const younger = vi.fn(() => 'younger')
			const immediate = limiter.run(younger, { key: 'B', priority: Priority.High, maxWaitMs: 0 })

			expect(older).toHaveBeenCalledOnce()
			expect(younger).not.toHaveBeenCalled()
			await expect(immediate).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
			await expect(waiting).resolves.toBe('older')
			const status = await limiter.getStatus('B')
			expect(status.profiles[0]?.used).toBe(0)
			await expect(limiter.run(younger, { key: 'B', maxWaitMs: 0 })).resolves.toBe('younger')
		})
	})

	it('should cancel a queued public submission and release its place before clear and destroy', async () => {
		vi.useFakeTimers({ now: 0 })
		const limiter = new FixedWindowLimiter({
			limitOptions: { limit: 1, windowMs: 100 },
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		const release = Promise.withResolvers<undefined>()
		const running = limiter.run(async () => await release.promise, { key: 'A' })
		const controller = new AbortController()
		const waiting = vi.fn()
		const cancelled = limiter.run(waiting, {
			key: 'B',
			signal: controller.signal,
			maxWaitMs: 1000,
			id: 'B1',
		})
		controller.abort()
		await expect(cancelled).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled, id: 'B1' })
		const status = await limiter.getStatus('B')
		expect(status.profiles[0]?.used).toBe(0)

		const queued = limiter.run(waiting, { key: 'B' })
		const rejected = expect(queued).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })
		await limiter.clear('B')
		await rejected
		const shutdown = limiter.destroy()
		release.resolve(undefined)
		await running
		await shutdown
		expect(waiting).not.toHaveBeenCalled()
	})

	describe('execution contract', () => {
		function createLimiter(options: RateLimiterOptions) {
			return new FixedWindowLimiter({
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
