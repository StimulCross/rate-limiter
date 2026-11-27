import type { PriorityWeights, RateLimiterOptions } from '../../../src/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Priority, RateLimitErrorCode } from '../../../src/index.js'
import { limiterFixtures } from '../../helpers/limiter-fixtures.js'

const lowFavoringWeights: PriorityWeights = {
	[Priority.Lowest]: 1,
	[Priority.Low]: 4,
	[Priority.Normal]: 1,
	[Priority.High]: 1,
	[Priority.Highest]: 1,
}

const startOrderCases: readonly {
	label: string
	options: RateLimiterOptions
	expected: readonly string[]
}[] = [
	{ label: 'omitted mode with default weights', options: {}, expected: ['H1', 'H2', 'L1', 'H3', 'L2'] },
	{ label: 'explicit weighted mode', options: { priorityMode: 'weighted' }, expected: ['H1', 'H2', 'L1', 'H3', 'L2'] },
	{ label: 'omitted mode with custom weights', options: { weights: lowFavoringWeights }, expected: ['L1', 'L2', 'H1', 'H2', 'H3'] },
	{ label: 'weighted mode with custom weights', options: { priorityMode: 'weighted', weights: lowFavoringWeights }, expected: ['L1', 'L2', 'H1', 'H2', 'H3'] },
	{ label: 'strict mode', options: { priorityMode: 'strict' }, expected: ['H1', 'H2', 'H3', 'L1', 'L2'] },
]

describe.each(limiterFixtures)('$name priority scheduling', ({ create }) => {
	beforeEach(() => {
		vi.useFakeTimers({
			now: 0,
			toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'],
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('class selection across ready keys', () => {
		it.each(startOrderCases)('should start contending work in the expected order with $label', async ({ options, expected }) => {
			const limiter = create({
				...options,
				limitBehavior: 'enqueue',
				queue: { capacity: 5, concurrency: 1 },
			})
			const hold = Promise.withResolvers<undefined>()
			const running = limiter.run(async () => await hold.promise, { key: 'active' })
			const order: string[] = []
			const waiting = ['L1', 'H1', 'H2', 'L2', 'H3'].map(async key => await limiter.run(() => {
				order.push(key)

				return Date.now()
			}, { key, priority: key.startsWith('H') ? Priority.High : Priority.Low }))
			const completion = Promise.all([running, ...waiting])

			expect(order).toEqual([])
			hold.resolve(undefined)
			await completion
			expect(order).toEqual(expected)
		})

		it('should reject defined weights in strict mode and accept explicit undefined', async () => {
			expect(() => create({ priorityMode: 'strict', weights: lowFavoringWeights })).toThrow(RangeError)

			const limiter = create({ priorityMode: 'strict', weights: undefined })
			await expect(limiter.run(Date.now)).resolves.toBe(0)
		})
	})

	describe('strict scheduling with changing quotas', () => {
		function createStrict(capacity: number) {
			return create({ priorityMode: 'strict', limitBehavior: 'enqueue', queue: { capacity, concurrency: 1 } })
		}

		it('should serve a ready Low and restore the older High ahead of ready work when its quota returns', async () => {
			const limiter = createStrict(3)
			await limiter.run(Date.now, { key: 'A' })
			const order: string[] = []
			const hold = Promise.withResolvers<number>()
			const older = limiter.run(() => {
				order.push('High A')

				return Date.now()
			}, { key: 'A', priority: Priority.High })
			const active = limiter.run(async () => {
				order.push('Low B')

				return await hold.promise
			}, { key: 'B', priority: Priority.Low, maxWaitMs: 0 })
			const younger = limiter.run(() => {
				order.push('High C')

				return Date.now()
			}, { key: 'C', priority: Priority.High })
			const low = limiter.run(() => {
				order.push('Low D')

				return Date.now()
			}, { key: 'D', priority: Priority.Low })
			const completion = Promise.all([older, active, younger, low])

			expect(order).toEqual(['Low B'])
			await vi.advanceTimersByTimeAsync(100)
			expect(order).toEqual(['Low B'])
			hold.resolve(0)
			await expect(completion).resolves.toEqual([100, 0, 100, 100])
			expect(order).toEqual(['Low B', 'High A', 'High C', 'Low D'])
		})

		it('should start a higher-priority zero-wait arrival even when the queue is full', async () => {
			const limiter = createStrict(1)
			await limiter.run(Date.now, { key: 'A' })
			const older = vi.fn(Date.now)
			const waiting = limiter.run(older, { key: 'A', priority: Priority.Low })
			expect(older).not.toHaveBeenCalled()

			// Make the queued key due without executing the quota alarm.
			vi.setSystemTime(100)
			const arrival = vi.fn(Date.now)
			const immediate = limiter.run(arrival, { key: 'B', priority: Priority.High, maxWaitMs: 0 })
			const completion = Promise.all([immediate, waiting])

			expect(arrival).toHaveBeenCalledOnce()
			expect(older).not.toHaveBeenCalled()
			await expect(completion).resolves.toEqual([100, 100])

			await expect(limiter.run(arrival, { key: 'B', maxWaitMs: 0 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
			})

			expect(arrival).toHaveBeenCalledOnce()
		})

		it('should reject a younger zero-wait arrival in the same class without debiting its key', async () => {
			const limiter = createStrict(1)
			await limiter.run(Date.now, { key: 'A' })
			const older = vi.fn(Date.now)
			const waiting = limiter.run(older, { key: 'A', priority: Priority.High })
			expect(older).not.toHaveBeenCalled()

			vi.setSystemTime(100)
			const arrival = vi.fn(Date.now)
			const immediate = limiter.run(arrival, { key: 'B', priority: Priority.High, maxWaitMs: 0 })
			await expect(immediate).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
			expect(older).toHaveBeenCalledOnce()
			expect(arrival).not.toHaveBeenCalled()
			await expect(waiting).resolves.toBe(100)
			await expect(limiter.run(arrival, { key: 'B', maxWaitMs: 0 })).resolves.toBe(100)
			expect(arrival).toHaveBeenCalledOnce()
		})
	})
})
