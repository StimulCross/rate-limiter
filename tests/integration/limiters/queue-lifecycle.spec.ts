import type { RateLimiterOptions } from '../../../src/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Priority, RateLimitErrorCode } from '../../../src/index.js'
import { limiterFixtures } from '../../helpers/limiter-fixtures.js'

const fixtures = limiterFixtures.flatMap(({ name, create }) =>
	(['weighted', 'strict'] as const).map(priorityMode => ({ name, create, priorityMode })),
)

describe.each(fixtures)('$name $priorityMode quota and queue lifecycle', ({ create: createLimiter, priorityMode }) => {
	function create(options: RateLimiterOptions) {
		return createLimiter({ ...options, priorityMode })
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

	afterEach(() => {
		vi.useRealTimers()
	})

	it('should start the queued callback before the previous task runs its then handler', async () => {
		const limiter = create({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		const hold = Promise.withResolvers<undefined>()
		const order: string[] = []
		const running = limiter.run(async () => await hold.promise, { key: 'A' })
		const observed = running.then(() => {
			order.push('then')
		})
		const waiting = limiter.run(() => {
			order.push('next callback')
		}, { key: 'B' })
		const settled = Promise.allSettled([observed, waiting])

		try {
			expect(order).toEqual([])
			hold.resolve(undefined)
			await observed
			expect(order).toEqual(['next callback', 'then'])
			await waiting
		}
		finally {
			hold.resolve(undefined)
			await limiter.destroy()
			await settled
		}
	})

	it('should return the same destroy promise before and after shutdown completes', async () => {
		const limiter = create({})
		const hold = Promise.withResolvers<undefined>()
		const running = limiter.run(async () => await hold.promise)
		const shutdown = limiter.destroy()

		try {
			expect(limiter.destroy()).toBe(shutdown)
			hold.resolve(undefined)
			await running
			await shutdown
			expect(limiter.destroy()).toBe(shutdown)
		}
		finally {
			hold.resolve(undefined)
			await shutdown
		}
	})

	it('should ignore legacy clock overrides passed by a JavaScript caller', async () => {
		const quotaNow = vi.fn(() => Infinity)
		const waitingNow = vi.fn(() => Infinity)
		const options = {
			limitBehavior: 'reject' as const,
			quotaClock: { now: quotaNow },
			waitingClock: { now: waitingNow },
		}
		const limiter = create(options)

		try {
			await expect(limiter.run(() => 'started')).resolves.toBe('started')
			expect(quotaNow).not.toHaveBeenCalled()
			expect(waitingNow).not.toHaveBeenCalled()
		}
		finally {
			await limiter.destroy()
		}
	})

	it('should start the live waiter when the head expires as quota becomes available', async () => {
		const limiter = create({
			limitBehavior: 'enqueue',
			queue: { capacity: 2, concurrency: 1 },
		})
		await limiter.run(Date.now, { key: 'A' })
		const expiredCallback = vi.fn()
		const survivorCallback = vi.fn(Date.now)
		const expiring = limiter.run(expiredCallback, { key: 'A', maxWaitMs: 100, priority: Priority.Highest })
		const survivor = limiter.run(survivorCallback, { key: 'A' })
		const settled = Promise.allSettled([expiring, survivor])

		try {
			await vi.advanceTimersByTimeAsync(99)
			expect(expiredCallback).not.toHaveBeenCalled()
			expect(survivorCallback).not.toHaveBeenCalled()
			await expect(limiter.run(Date.now, { key: 'B', maxWaitMs: 0 })).resolves.toBe(99)

			await vi.advanceTimersByTimeAsync(1)
			await expect(expiring).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
			expect(expiredCallback).not.toHaveBeenCalled()
			expect(survivorCallback).toHaveBeenCalledOnce()
			await expect(survivor).resolves.toBe(100)

			await expect(limiter.run(Date.now, { key: 'A', maxWaitMs: 0 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
				retryAfterMs: 100,
			})
		}
		finally {
			await limiter.destroy()
			await settled
		}
	})

	it('should reuse a queue place after aborting the head while the only slot is occupied', async () => {
		const limiter = create({
			limitBehavior: 'enqueue',
			queue: { capacity: 2, concurrency: 1 },
		})
		await limiter.run(Date.now, { key: 'A' })
		const hold = Promise.withResolvers<undefined>()
		const running = limiter.run(async () => await hold.promise, { key: 'B' })
		const controller = new AbortController()
		const abortedCallback = vi.fn()
		const survivorCallback = vi.fn(Date.now)
		const replacementCallback = vi.fn(Date.now)
		const aborted = limiter.run(abortedCallback, { key: 'A', signal: controller.signal })
		const survivor = limiter.run(survivorCallback, { key: 'A' })
		const settled = Promise.allSettled([running, aborted, survivor])
		let replacementSettled: Promise<unknown> | undefined

		try {
			await vi.advanceTimersByTimeAsync(100)
			expect(abortedCallback).not.toHaveBeenCalled()
			expect(survivorCallback).not.toHaveBeenCalled()
			controller.abort()
			const replacement = limiter.run(replacementCallback, { key: 'A' })
			replacementSettled = Promise.allSettled([replacement])

			await expect(aborted).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

			await expect(limiter.run(Date.now, { key: 'A', priority: Priority.Highest })).rejects.toMatchObject({
				code: RateLimitErrorCode.QueueOverflow,
			})

			expect(replacementCallback).not.toHaveBeenCalled()
			hold.resolve(undefined)
			await running
			expect(survivorCallback).toHaveBeenCalledOnce()
			await expect(survivor).resolves.toBe(100)
			expect(replacementCallback).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(100)
			expect(replacementCallback).toHaveBeenCalledOnce()
			await expect(replacement).resolves.toBe(200)
			expect(abortedCallback).not.toHaveBeenCalled()
		}
		finally {
			hold.resolve(undefined)
			await limiter.destroy()
			await settled
			await replacementSettled
		}
	})

	it('should keep a started callback running after its waiting deadline and abort', async () => {
		const limiter = create({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		await limiter.run(Date.now, { key: 'A' })
		const hold = Promise.withResolvers<undefined>()
		const controller = new AbortController()
		const runningCallback = vi.fn(async () => {
			const startedAt = Date.now()
			await hold.promise

			return startedAt
		})
		const otherKeyCallback = vi.fn(Date.now)
		const running = limiter.run(runningCallback, { key: 'A', maxWaitMs: 110, signal: controller.signal })
		let settled: Promise<unknown> = Promise.allSettled([running])

		try {
			expect(runningCallback).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(100)
			expect(runningCallback).toHaveBeenCalledOnce()
			const otherKey = limiter.run(otherKeyCallback, { key: 'B' })
			settled = Promise.allSettled([running, otherKey])

			await vi.advanceTimersByTimeAsync(10)
			controller.abort()
			await vi.advanceTimersByTimeAsync(0)
			expect(otherKeyCallback).not.toHaveBeenCalled()
			hold.resolve(undefined)
			await expect(running).resolves.toBe(100)
			expect(otherKeyCallback).toHaveBeenCalledOnce()
			await expect(otherKey).resolves.toBe(110)

			await expect(limiter.run(Date.now, { key: 'A', maxWaitMs: 0 })).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
				retryAfterMs: 90,
			})
		}
		finally {
			hold.resolve(undefined)
			await limiter.destroy()
			await settled
		}
	})
})
