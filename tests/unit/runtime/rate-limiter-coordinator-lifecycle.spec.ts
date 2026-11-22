import type { FixedWindowState } from '../../../src/limiters/fixed-window/fixed-window.state.js'
import type { FixedWindowStatus } from '../../../src/limiters/fixed-window/index.js'
import { LogLevel } from '@stimulcross/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Priority, RateLimitErrorCode } from '../../../src/index.js'
import { FixedWindowPolicy } from '../../../src/limiters/fixed-window/fixed-window.policy.js'
import { RateLimiterCoordinator } from '../../../src/runtime/rate-limiter-coordinator.js'

type CoordinatorArguments = ConstructorParameters<typeof RateLimiterCoordinator<FixedWindowState, FixedWindowStatus>>

function createCoordinator(options?: CoordinatorArguments[1], windowMs = 100, clocks?: CoordinatorArguments[3]) {
	return new RateLimiterCoordinator(new FixedWindowPolicy([
		{ limit: 1, windowMs },
	]), {
		limitBehavior: 'enqueue',
		queue: { capacity: 2, concurrency: 1 },
		...options,
	}, undefined, clocks)
}

describe('RateLimiterCoordinator lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers({
			now: 0,
			toFake: [
				'setTimeout',
				'clearTimeout',
				'Date',
				'performance',
			],
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('should start a quota-blocked waiter at the boundary without a new submission', async () => {
		const coordinator = createCoordinator()
		await coordinator.run(() => {})
		const callback = vi.fn(() => 'ready')
		const waiter = coordinator.run(callback)
		expect(vi.getTimerCount()).toBe(1)

		await vi.advanceTimersByTimeAsync(99)
		expect(callback).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await expect(waiter).resolves.toBe('ready')
		expect(callback).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('should reorder two queued keys when the earlier quota wakeup moves later', async () => {
		let wakeAtA = 100
		const coordinator = new RateLimiterCoordinator({
			check: (chargedAt: number | undefined, now) => {
				if (chargedAt === undefined)
					return undefined

				const wakeAt = chargedAt === 0
					? wakeAtA
					: chargedAt + 149

				return wakeAt > now
					? wakeAt
					: undefined
			},
			charge: (_state, time) => time,
			getStatus: chargedAt => chargedAt,
		}, {
			limitBehavior: 'enqueue',
			queue: { capacity: 2 },
		})
		await coordinator.run(() => {}, { key: 'A' })
		await vi.advanceTimersByTimeAsync(1)
		await coordinator.run(() => {}, { key: 'B' })

		const startOrder: string[] = []
		const first = coordinator.run(() => startOrder.push('A'), { key: 'A' })
		const second = coordinator.run(() => startOrder.push('B'), { key: 'B' })
		wakeAtA = 200

		await expect(coordinator.run(() => {}, { key: 'A', limitBehavior: 'reject' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 199,
		})

		await vi.advanceTimersByTimeAsync(148)
		expect(startOrder).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(startOrder).toEqual(['B'])

		await vi.advanceTimersByTimeAsync(50)
		expect(startOrder).toEqual(['B', 'A'])
		await Promise.all([first, second])
		expect(vi.getTimerCount()).toBe(0)
	})

	it('should rearm an early quota wakeup when epoch time rolls back', async () => {
		const coordinator = createCoordinator()
		await coordinator.run(() => {})
		const callback = vi.fn()
		const waiter = coordinator.run(callback)

		await vi.advanceTimersByTimeAsync(50)
		vi.setSystemTime(0)
		await vi.advanceTimersByTimeAsync(50)
		expect(callback).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(49)
		expect(callback).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)

		await waiter
		expect(callback).toHaveBeenCalledOnce()
	})

	it('should rearm host timers for waits beyond the platform delay limit', async () => {
		const windowMs = 2_147_483_670
		const coordinator = createCoordinator(undefined, windowMs)
		await coordinator.run(() => {})
		const callback = vi.fn()
		const waiter = coordinator.run(callback)

		await vi.advanceTimersByTimeAsync(windowMs - 1)
		expect(callback).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(1)
		await waiter
		expect(callback).toHaveBeenCalledOnce()
	})

	it('should expire and release waiting capacity while the only slot is occupied', async () => {
		const coordinator = createCoordinator({
			queue: { capacity: 1, concurrency: 1 },
		})
		const hold = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'A' })
		const expired = vi.fn()
		const waiter = coordinator.run(expired, { key: 'A', maxWaitMs: 25 })
		const rejection = vi.fn()
		void waiter.catch(rejection)
		expect(vi.getTimerCount()).toBe(2)

		vi.setSystemTime(-1_000_000)
		await vi.advanceTimersByTimeAsync(24)
		expect(vi.getTimerCount()).toBe(2)
		expect(rejection).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(rejection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: RateLimitErrorCode.Expired }))
		expect(vi.getTimerCount()).toBe(0)

		const replacement = vi.fn(() => 'replacement')
		const next = coordinator.run(replacement, { key: 'B' })
		expect(replacement).not.toHaveBeenCalled()
		hold.resolve(undefined)
		await running
		await expect(next).resolves.toBe('replacement')
		expect(expired).not.toHaveBeenCalled()
	})

	it('should remove an expiring head before selection at a simultaneous quota refill', async () => {
		const coordinator = createCoordinator()
		await coordinator.run(() => {})
		const expired = vi.fn()
		const expiring = coordinator.run(expired, { maxWaitMs: 100, priority: Priority.Highest })
		const rejection = expect(expiring).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
		const next = coordinator.run(() => 'survivor')

		await vi.advanceTimersByTimeAsync(100)
		await rejection
		await expect(next).resolves.toBe('survivor')
		expect(expired).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('should expire waiters by their individual deadlines while an execution slot is held', async () => {
		const coordinator = createCoordinator({
			queue: { capacity: 3, concurrency: 1, maxWaitMs: 25 },
		})
		const hold = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'running' })
		const survivor = vi.fn(() => 'survivor')
		const expired = vi.fn()
		const long = coordinator.run(survivor, { key: 'A', maxWaitMs: 75 })
		const outcomes: Promise<unknown>[] = [
			Promise.allSettled([running, long]),
		]

		try {
			await vi.advanceTimersByTimeAsync(5)
			const standard = coordinator.run(expired, { key: 'A' })
			const standardRejected = vi.fn()
			outcomes.push(standard.catch(standardRejected))
			await vi.advanceTimersByTimeAsync(5)
			const short = coordinator.run(expired, { key: 'A', maxWaitMs: 5, priority: Priority.Highest })
			const shortRejected = vi.fn()
			outcomes.push(short.catch(shortRejected))

			vi.setSystemTime(10_000)
			await vi.advanceTimersByTimeAsync(4)
			expect(shortRejected).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			await expect(short).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
			expect(standardRejected).not.toHaveBeenCalled()

			vi.setSystemTime(-10_000)
			await vi.advanceTimersByTimeAsync(14)
			expect(standardRejected).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			await expect(standard).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
			expect(survivor).not.toHaveBeenCalled()
			expect(expired).not.toHaveBeenCalled()

			hold.resolve(undefined)
			await running
			await expect(long).resolves.toBe('survivor')
			expect(survivor).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
		}
		finally {
			hold.resolve(undefined)
			await coordinator.destroy()
			await Promise.all(outcomes)
		}
	})

	it('should keep a running slot and its charge after its deadline and signal fire', async () => {
		const coordinator = createCoordinator({
			queue: { capacity: 1, concurrency: 1 },
		})
		const hold = Promise.withResolvers<string>()
		const controller = new AbortController()
		const running = coordinator.run(async () => await hold.promise, { key: 'A', maxWaitMs: 10, signal: controller.signal })
		const callback = vi.fn(() => 'next')
		const waiting = coordinator.run(callback, { key: 'B' })

		await vi.advanceTimersByTimeAsync(10)
		controller.abort()
		expect(callback).not.toHaveBeenCalled()
		expect(coordinator.getStatus('A').profiles[0]?.remaining).toBe(0)

		hold.resolve('original result')
		await expect(running).resolves.toBe('original result')
		await expect(waiting).resolves.toBe('next')
		expect(callback).toHaveBeenCalledOnce()
	})

	it('should reject only the affected key when a quota check fails at a shared wakeup', async () => {
		const failure = new Error('quota check failed')
		const output = vi.fn()
		const coordinator = new RateLimiterCoordinator({
			check: (startedAt: number | undefined, now) => {
				if (startedAt === 0 && now >= 100)
					throw failure

				return startedAt !== undefined && now < 100
					? 100
					: undefined
			},
			charge: (_startedAt, now) => now,
			getStatus: startedAt => startedAt,
		}, {
			limitBehavior: 'enqueue',
			queue: { capacity: 3 },
			loggerOptions: { minLevel: 'error', custom: output },
		})
		await coordinator.run(() => {}, { key: 'A' })
		await vi.advanceTimersByTimeAsync(1)
		await coordinator.run(() => {}, { key: 'B' })

		const affected = vi.fn()
		const first = coordinator.run(affected, { key: 'A', maxWaitMs: 200 })
		const second = coordinator.run(affected, { key: 'A', maxWaitMs: 200, priority: Priority.Highest })
		const survivor = coordinator.run(() => 'survivor', { key: 'B' })
		const rejected = Promise.all([
			expect(first).rejects.toBe(failure),
			expect(second).rejects.toBe(failure),
		])

		await vi.advanceTimersByTimeAsync(99)
		await rejected
		await expect(survivor).resolves.toBe('survivor')
		expect(affected).not.toHaveBeenCalled()
		expect(output).toHaveBeenCalledExactlyOnceWith(LogLevel.ERROR, '[LIMITER FAILED] | phase=quota', failure)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('should release the execution slot and preserve the callback result when a settlement hook throws', async () => {
		const failure = new Error('settlement failed')
		const output = vi.fn()
		const coordinator = new RateLimiterCoordinator({
			check: () => undefined,
			charge: () => 1,
			getStatus: state => state,
			trackSettlement: (_state, { key }) => () => {
				if (key === 'A')
					throw failure
			},
		}, {
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
			loggerOptions: { minLevel: 'error', custom: output },
		})
		const hold = Promise.withResolvers<string>()
		const running = coordinator.run(async () => await hold.promise, { key: 'A' })
		const callback = vi.fn(() => 'next')
		const waiting = coordinator.run(callback, { key: 'B' })
		expect(callback).not.toHaveBeenCalled()

		hold.resolve('original result')
		await expect(running).resolves.toBe('original result')
		await expect(waiting).resolves.toBe('next')
		expect(callback).toHaveBeenCalledOnce()
		expect(output).toHaveBeenCalledExactlyOnceWith(LogLevel.ERROR, '[LIMITER FAILED] | phase=settlement', failure)
	})

	it('should release waiting resources after a drain clock failure and admit new work when time recovers', async () => {
		let now = 0
		const output = vi.fn()
		const coordinator = createCoordinator({
			queue: { capacity: 2, concurrency: 1 },
			loggerOptions: { minLevel: 'error', custom: output },
		}, undefined, {
			quotaClock: {
				now: () => now,
			},
		})
		const hold = Promise.withResolvers<string>()
		const running = coordinator.run(async () => await hold.promise, { key: 'A' })
		const callback = vi.fn(() => 'started')
		const first = coordinator.run(callback, { key: 'B', maxWaitMs: 200 })
		const second = coordinator.run(callback, { key: 'A', maxWaitMs: 200 })
		const rejected = Promise.all([
			expect(first).rejects.toThrow(RangeError),
			expect(second).rejects.toThrow(RangeError),
		])

		now = Number.NaN
		hold.resolve('original result')
		await expect(running).resolves.toBe('original result')
		await rejected
		expect(callback).not.toHaveBeenCalled()
		expect(output).toHaveBeenCalledExactlyOnceWith(LogLevel.ERROR, '[LIMITER FAILED] | phase=drain', expect.any(RangeError))
		expect(vi.getTimerCount()).toBe(0)

		now = 0
		await expect(coordinator.run(callback, { key: 'B' })).resolves.toBe('started')
		expect(callback).toHaveBeenCalledOnce()
	})

	it('should unlink all waiters sharing a signal even when the source event is stopped', async () => {
		const coordinator = createCoordinator()
		const hold = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'A' })
		const controller = new AbortController()
		controller.signal.addEventListener('abort', event => event.stopImmediatePropagation())
		const callback = vi.fn()
		const first = coordinator.run(callback, { key: 'A', maxWaitMs: 50, signal: controller.signal })
		const second = coordinator.run(callback, { key: 'B', maxWaitMs: 50, signal: controller.signal })

		controller.abort()

		await Promise.all([first, second].map(async result =>
			await expect(result).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled }),
		))

		expect(vi.getTimerCount()).toBe(0)
		const survivor = coordinator.run(() => 'survivor', { key: 'B' })
		hold.resolve(undefined)
		await running
		await expect(survivor).resolves.toBe('survivor')
		expect(callback).not.toHaveBeenCalled()
	})

	it('should clear only the selected key and keep the running slot occupied', async () => {
		const coordinator = createCoordinator()
		const hold = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'A' })
		const cleared = vi.fn()
		const a = coordinator.run(cleared, { key: 'A', maxWaitMs: 50 })
		const survivor = vi.fn(() => 'B')
		const b = coordinator.run(survivor, { key: 'B', maxWaitMs: 150 })
		const rejection = expect(a).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })

		coordinator.clear('A')
		await rejection
		expect(vi.getTimerCount()).toBe(1)
		expect(survivor).not.toHaveBeenCalled()

		await expect(coordinator.run(cleared, { key: 'A', maxWaitMs: 0 })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: null,
		})

		const newA = coordinator.run(() => 'new A', { key: 'A' })
		hold.resolve(undefined)
		await running
		await expect(b).resolves.toBe('B')
		await expect(newA).resolves.toBe('new A')
		expect(cleared).not.toHaveBeenCalled()
	})

	it.each(['keyed', 'instance'] as const)('should ignore old alarm callbacks after %s clear and resubmission', async scope => {
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
		const coordinator = createCoordinator()
		await coordinator.run(() => {})
		const old = coordinator.run(() => 'old', { maxWaitMs: 2000 })
		const rejection = expect(old).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })
		const wake = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 100)?.[0]
		const deadline = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 2000)?.[0]
		expect(wake).toBeTypeOf('function')
		expect(deadline).toBeTypeOf('function')

		coordinator.clear(scope === 'keyed'
			? ''
			: undefined)

		await rejection
		expect(vi.getTimerCount()).toBe(0)
		await coordinator.run(() => {})
		const fresh = vi.fn(() => 'fresh')
		const waiting = coordinator.run(fresh)
		vi.setSystemTime(100)

		if (typeof wake === 'function')
			wake()

		if (typeof deadline === 'function')
			deadline()

		expect(fresh).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)

		await vi.advanceTimersByTimeAsync(100)
		await expect(waiting).resolves.toBe('fresh')
	})

	it('should preserve class balances across an instance clear while clearing all keyed quotas', async () => {
		const coordinator = createCoordinator({
			weights: {
				[Priority.Lowest]: 1,
				[Priority.Low]: 1,
				[Priority.Normal]: 1,
				[Priority.High]: 1,
				[Priority.Highest]: 1,
			},
		})
		const hold = Promise.withResolvers<undefined>()
		const holdHigh = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'running' })
		const high = vi.fn(async () => await holdHigh.promise)
		const highResult = coordinator.run(high, { key: 'high', priority: Priority.High })
		const low = coordinator.run(() => 'old low', { key: 'low', priority: Priority.Low })
		const cleared = expect(low).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })

		hold.resolve(undefined)
		await running
		expect(high).toHaveBeenCalledOnce()
		coordinator.clear()
		await cleared

		const order: string[] = []
		const secondHigh = coordinator.run(() => order.push('high'), { key: 'high', priority: Priority.High })
		const secondLow = coordinator.run(() => order.push('low'), { key: 'low', priority: Priority.Low })
		expect(order).toEqual([])
		holdHigh.resolve(undefined)
		await Promise.all([highResult, secondHigh, secondLow])
		expect(order).toEqual(['low', 'high'])
	})

	it('should let a callback clear its key and start a new quota history during reentry', async () => {
		const coordinator = createCoordinator({
			queue: { capacity: 1, concurrency: 2 },
		})
		const cleared = vi.fn()
		const replacement = vi.fn(() => 'new history')
		const result = coordinator.run(async () => {
			const pending = coordinator.run(cleared, { key: 'A' })
			const rejection = expect(pending).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })
			coordinator.clear('A')
			const newRun = coordinator.run(replacement, { key: 'A', maxWaitMs: 0 })

			expect(replacement).toHaveBeenCalledOnce()
			await rejection

			return await newRun
		}, { key: 'A' })

		await expect(result).resolves.toBe('new history')
		expect(cleared).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	/* eslint-disable ts/dot-notation -- Inspect retained records to verify the physical storage bounds. */
	it('should close admission immediately and await successful and failed running results on destroy', async () => {
		const coordinator = createCoordinator({
			queue: { capacity: 2, concurrency: 2 },
		})
		const good = Promise.withResolvers<undefined>()
		const bad = Promise.withResolvers<undefined>()
		const first = coordinator.run(async () => await good.promise, { key: 'A' })
		const second = coordinator.run(async () => await bad.promise, { key: 'B' })
		const source = new AbortController()
		const callback = vi.fn()
		const pending = coordinator.run(callback, { key: 'A', maxWaitMs: 60, signal: source.signal })
		const rejected = expect(pending).rejects.toMatchObject({ code: RateLimitErrorCode.Destroyed })
		const drained = vi.fn()

		const shutdown = coordinator.destroy()
		expect(coordinator.destroy()).toBe(shutdown)
		void shutdown.then(drained)
		await rejected
		await expect(coordinator.run(callback, { key: 'C' })).rejects.toMatchObject({ code: RateLimitErrorCode.Destroyed })
		expect(vi.getTimerCount()).toBe(0)
		source.abort()

		good.resolve(undefined)
		await first
		expect(drained).not.toHaveBeenCalled()
		const error = new Error('running callback failed')
		const failed = expect(second).rejects.toBe(error)
		bad.reject(error)
		await failed
		await shutdown
		expect(drained).toHaveBeenCalledOnce()
		expect(callback).not.toHaveBeenCalled()
		expect(coordinator['_keys'].size).toBe(0)
		expect(coordinator['_abortGroups'].size).toBe(0)
	})

	it('should bound physical waiters, timers and listeners across repeated tail and blocked-key cancellation', async () => {
		const coordinator = createCoordinator()
		const add = vi.spyOn(AbortSignal.prototype, 'addEventListener')
		const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
		await coordinator.run(() => {}, { key: 'blocked' })
		const hold = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'running' })
		const callback = vi.fn()
		const head = coordinator.run(callback, { key: 'ready', maxWaitMs: 1000 })
		const scheduler = coordinator['_scheduler']
		const deadlines = coordinator['_deadlines']
		const wakeups = coordinator['_wakeups']

		for (let index = 0; index < 1000; index++) {
			const controller = new AbortController()
			const key = index % 2 === 0
				? 'ready'
				: 'blocked'
			const waiter = coordinator.run(callback, { key, signal: controller.signal, maxWaitMs: 2000 })
			expect(deadlines['_data']).toHaveLength(2)

			expect(wakeups['_data']).toHaveLength(key === 'blocked'
				? 1
				: 0)

			controller.abort()
			await expect(waiter).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

			expect([
				...scheduler.getTasks('ready'),
			]).toHaveLength(1)

			expect([
				...scheduler.getTasks('blocked'),
			]).toHaveLength(0)

			expect(scheduler['_ready'][Priority.Normal - 1]['_data']).toHaveLength(1)
			expect(deadlines['_data']).toHaveLength(1)
			expect(deadlines['_positions'].size).toBe(1)
			expect(wakeups['_data']).toHaveLength(0)
			expect(wakeups['_positions'].size).toBe(0)
			expect(coordinator['_abortGroups'].size).toBe(0)
			expect(vi.getTimerCount()).toBe(1)
		}

		expect(add.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1000)
		expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1000)
		expect(callback).not.toHaveBeenCalled()

		hold.resolve(undefined)
		await running
		await head
		expect(callback).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})
	/* eslint-enable ts/dot-notation */
})
