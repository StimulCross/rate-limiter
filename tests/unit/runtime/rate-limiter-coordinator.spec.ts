import type { FixedWindowState } from '../../../src/limiters/fixed-window/fixed-window.state.js'
import type { FixedWindowLimitOptions, FixedWindowStatus } from '../../../src/limiters/fixed-window/index.js'
import { describe, expect, it, vi } from 'vitest'
import { Priority, RateLimitErrorCode } from '../../../src/index.js'
import { FixedWindowPolicy } from '../../../src/limiters/fixed-window/fixed-window.policy.js'
import { RateLimiterCoordinator } from '../../../src/runtime/rate-limiter-coordinator.js'

function createCoordinator(
	options?: ConstructorParameters<typeof RateLimiterCoordinator<FixedWindowState, FixedWindowStatus>>[1],
	profiles: readonly FixedWindowLimitOptions[] = [
		{ limit: 1, windowMs: 1000 },
	],
) {
	const clock = { epoch: 0, monotonic: 0 }
	const policy = new FixedWindowPolicy(profiles)
	const coordinator = new RateLimiterCoordinator(policy, options, undefined, {
		quotaClock: {
			now: () => clock.epoch,
		},
		waitingClock: {
			now: () => clock.monotonic,
		},
	})

	return { clock, coordinator }
}

describe('RateLimiterCoordinator', () => {
	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.MAX_SAFE_INTEGER + 1,
	])('should reject invalid concurrency %s', concurrency => {
		expect(() => createCoordinator({
			queue: { concurrency },
		})).toThrow(RangeError)
	})

	it('should require explicit waiting capacity for both default and per-task enqueue', async () => {
		expect(() => createCoordinator({ limitBehavior: 'enqueue' })).toThrow(RangeError)
		const { coordinator } = createCoordinator()
		const callback = vi.fn(() => 'started')

		await expect(coordinator.run(callback, { limitBehavior: 'enqueue' })).rejects.toThrow(RangeError)
		expect(callback).not.toHaveBeenCalled()
		await expect(coordinator.run(callback)).resolves.toBe('started')
	})

	it.each([-1, Number.NaN])('should reject a default or per-task wait limit of %s', async maxWaitMs => {
		expect(() => createCoordinator({
			queue: { maxWaitMs },
		})).toThrow(RangeError)

		const { coordinator } = createCoordinator()
		const callback = vi.fn(() => 'started')

		await expect(coordinator.run(callback, { maxWaitMs })).rejects.toThrow(RangeError)
		expect(callback).not.toHaveBeenCalled()
	})

	it.each(['epoch', 'monotonic'] as const)('should reject a nonfinite %s sample without consuming quota', async clockName => {
		const { clock, coordinator } = createCoordinator()
		const callback = vi.fn(() => 'started')
		clock[clockName] = Infinity

		await expect(coordinator.run(callback)).rejects.toThrow(RangeError)
		expect(callback).not.toHaveBeenCalled()
		clock[clockName] = 0
		await expect(coordinator.run(callback)).resolves.toBe('started')
	})

	it('should reject a pre-aborted arrival without charging quota even when a slot is free', async () => {
		const { coordinator } = createCoordinator({
			limitBehavior: 'enqueue',
			queue: { capacity: 0, concurrency: 1 },
		})
		const callback = vi.fn(() => 'started')

		await expect(coordinator.run(callback, {
			signal: AbortSignal.abort(),
			id: 'aborted',
		})).rejects.toMatchObject({
			code: RateLimitErrorCode.Cancelled,
			id: 'aborted',
		})

		expect(callback).not.toHaveBeenCalled()
		await expect(coordinator.run(callback)).resolves.toBe('started')
	})

	it('should count time spent generating an id toward the waiting deadline', async () => {
		let now = 0
		const coordinator = new RateLimiterCoordinator(new FixedWindowPolicy([
			{ limit: 1, windowMs: 1000 },
		]), {
			idGenerator: () => {
				now = 10

				return 'generated'
			},
		}, undefined, {
			quotaClock: {
				now: () => 0,
			},
			waitingClock: {
				now: () => now,
			},
		})
		const callback = vi.fn(() => 'started')

		await expect(coordinator.run(callback, { maxWaitMs: 10 })).rejects.toMatchObject({
			code: RateLimitErrorCode.Expired,
			id: 'generated',
		})

		expect(callback).not.toHaveBeenCalled()
		await expect(coordinator.run(callback, { id: 'fresh', maxWaitMs: 0 })).resolves.toBe('started')
	})

	it('should start zero-wait work synchronously with zero queue capacity', async () => {
		const { coordinator } = createCoordinator({
			limitBehavior: 'enqueue',
			queue: { capacity: 0, concurrency: 1 },
		})
		const callback = vi.fn(() => 'started')

		const result = coordinator.run(callback, { maxWaitMs: 0 })
		expect(callback).toHaveBeenCalledOnce()
		await expect(result).resolves.toBe('started')
	})

	it('should choose the older due task over an immediate arrival at full capacity', async () => {
		const { clock, coordinator } = createCoordinator({
			queue: { capacity: 1, concurrency: 1 },
		})
		await coordinator.run(() => {}, { key: 'A' })

		const older = vi.fn(() => 'older')
		const waiting = coordinator.run(older, { key: 'A', limitBehavior: 'enqueue' })
		const overflow = vi.fn()

		await expect(coordinator.run(overflow, {
			key: 'A',
			priority: Priority.Highest,
			limitBehavior: 'enqueue',
		})).rejects.toMatchObject({ code: RateLimitErrorCode.QueueOverflow })

		expect(overflow).not.toHaveBeenCalled()

		clock.epoch = 1000
		const fresh = vi.fn(() => 'fresh')
		const rejected = coordinator.run(fresh, { key: 'B' })
		expect(older).toHaveBeenCalledOnce()
		expect(fresh).not.toHaveBeenCalled()
		await expect(rejected).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
		await expect(waiting).resolves.toBe('older')
		await expect(coordinator.run(fresh, { key: 'B' })).resolves.toBe('fresh')
	})

	it('should start a winning arrival at full capacity and drain the waiter after release', async () => {
		const { clock, coordinator } = createCoordinator({
			queue: { capacity: 1, concurrency: 1 },
		})
		await coordinator.run(() => {}, { key: 'A' })
		const older = vi.fn(() => 'older')
		const waiting = coordinator.run(older, { key: 'A', limitBehavior: 'enqueue' })

		clock.epoch = 1000
		const hold = Promise.withResolvers<string>()
		const fresh = vi.fn(async () => await hold.promise)
		const result = coordinator.run(fresh, { key: 'B', priority: Priority.High })

		expect(fresh).toHaveBeenCalledOnce()
		expect(older).not.toHaveBeenCalled()
		hold.resolve('fresh')
		await expect(result).resolves.toBe('fresh')
		await expect(waiting).resolves.toBe('older')
	})

	it('should put the losing waitable arrival in the freed place before invoking the winner', async () => {
		const { clock, coordinator } = createCoordinator({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		await coordinator.run(() => {}, { key: 'A' })
		const hold = Promise.withResolvers<undefined>()
		const nested = vi.fn(() => 'nested')
		let nestedResult: Promise<string> | undefined
		const older = coordinator.run(async () => {
			nestedResult = coordinator.run(nested, { key: 'C' })

			return await hold.promise
		}, { key: 'A' })

		clock.epoch = 1000
		const fresh = vi.fn(() => 'fresh')
		const waiting = coordinator.run(fresh, { key: 'B' })
		expect(nestedResult).toBeDefined()
		expect(nested).not.toHaveBeenCalled()
		expect(fresh).not.toHaveBeenCalled()
		await expect(nestedResult).rejects.toMatchObject({ code: RateLimitErrorCode.QueueOverflow })

		hold.resolve(undefined)
		await older
		await expect(waiting).resolves.toBe('fresh')
	})

	it('should expose the occupied last slot to reentry without charging the nested key', async () => {
		const { coordinator } = createCoordinator({
			queue: { capacity: 0, concurrency: 1 },
		})
		const nested = vi.fn(() => 'nested')
		const outer = coordinator.run(async () => await coordinator.run(nested, { key: 'B', maxWaitMs: 0 }), { key: 'A' })

		expect(nested).not.toHaveBeenCalled()
		await expect(outer).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded, retryAfterMs: null })
		await expect(coordinator.run(nested, { key: 'B' })).resolves.toBe('nested')
	})

	it('should start nested work synchronously with a spare slot and expose the charge on the outer key', async () => {
		const { coordinator } = createCoordinator({
			queue: { capacity: 0, concurrency: 2 },
		}, [
			{ limit: 1, windowMs: 500 },
			{ limit: 1, windowMs: 1000 },
		])
		const otherKey = vi.fn(() => 'nested')
		const sameKey = vi.fn()
		const outer = coordinator.run(async () => {
			const blocked = coordinator.run(sameKey, { key: 'A', maxWaitMs: 0 })
			const nested = coordinator.run(otherKey, { key: 'B', maxWaitMs: 0 })
			expect(otherKey).toHaveBeenCalledOnce()
			expect(sameKey).not.toHaveBeenCalled()

			return await Promise.allSettled([blocked, nested])
		}, { key: 'A' })

		await expect(outer).resolves.toMatchObject([
			{
				status: 'rejected',
				reason: { code: RateLimitErrorCode.LimitExceeded, retryAfterMs: 1000 },
			},
			{ status: 'fulfilled', value: 'nested' },
		])
	})

	it('should release the slot after a synchronous throw and keep the quota charged', async () => {
		const { coordinator } = createCoordinator({
			queue: { concurrency: 1 },
		})
		const error = new Error('callback threw')
		const callback = vi.fn(() => {
			throw error
		})

		const result = coordinator.run(callback, { key: 'A' })
		expect(callback).toHaveBeenCalledOnce()
		await expect(result).rejects.toBe(error)

		await expect(coordinator.run(() => 'other', { key: 'B' })).resolves.toBe('other')

		await expect(coordinator.run(() => 'same', { key: 'A' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 1000,
		})
	})

	it('should keep the slot through thenable assimilation and release it once on settlement', async () => {
		const { coordinator } = createCoordinator({
			limitBehavior: 'enqueue',
			queue: { capacity: 2, concurrency: 1 },
		})
		const settle = Promise.withResolvers<() => void>()
		const holdSecond = Promise.withResolvers<undefined>()
		const thenable = {
			// eslint-disable-next-line unicorn/no-thenable -- Exercises native thenable assimilation.
			then(resolve: (value: string) => void, reject: (reason: Error) => void) {
				settle.resolve(() => {
					resolve('first')
					reject(new Error('ignored'))
					resolve('ignored')
				})
			},
		}
		const second = vi.fn(async () => await holdSecond.promise)
		const third = vi.fn(() => 'third')

		const firstResult = coordinator.run(() => thenable as unknown as PromiseLike<string>, { key: 'first' })
		const secondResult = coordinator.run(second, { key: 'second' })
		const thirdResult = coordinator.run(third, { key: 'third' })
		const finish = await settle.promise
		expect(second).not.toHaveBeenCalled()
		expect(third).not.toHaveBeenCalled()

		finish()
		await expect(firstResult).resolves.toBe('first')
		expect(second).toHaveBeenCalledOnce()
		expect(third).not.toHaveBeenCalled()
		holdSecond.resolve(undefined)
		await secondResult
		await expect(thirdResult).resolves.toBe('third')
	})

	it('should release the slot after a throwing thenable getter and keep the quota charged', async () => {
		const { coordinator } = createCoordinator({
			queue: { concurrency: 1 },
		})
		const error = new Error('then getter threw')
		const result = coordinator.run<string>(() => ({
			// eslint-disable-next-line unicorn/no-thenable -- Exercises rejection during native thenable assimilation.
			get then(): never {
				throw error
			},
		}), { key: 'A' })

		await expect(result).rejects.toBe(error)
		await expect(coordinator.run(() => 'other', { key: 'B' })).resolves.toBe('other')

		await expect(coordinator.run(() => 'same', { key: 'A' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
		})
	})

	it('should reject self-resolution of a queued result and release its slot', async () => {
		const { coordinator } = createCoordinator({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		const hold = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'running' })
		// eslint-disable-next-line ts/promise-function-async -- Exercise the returned promise's own resolution.
		const queued: Promise<string> = coordinator.run(() => queued, { key: 'queued' })
		const rejected = expect(queued).rejects.toThrow(TypeError)
		hold.resolve(undefined)
		await running
		await rejected
		await expect(coordinator.run(() => 'next', { key: 'next' })).resolves.toBe('next')
	})

	it('should use the observed quota time when the epoch rolls back before a slot is released', async () => {
		const { clock, coordinator } = createCoordinator({
			queue: { capacity: 1, concurrency: 1 },
		}, [
			{ limit: 1, windowMs: 100 },
		])
		await coordinator.run(() => {}, { key: 'A' })
		const hold = Promise.withResolvers<undefined>()
		const running = coordinator.run(async () => await hold.promise, { key: 'B' })
		const waiting = coordinator.run(() => 'started', { key: 'A', limitBehavior: 'enqueue' })

		clock.epoch = 150

		await expect(coordinator.run(() => {}, { key: 'C' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
		})

		clock.epoch = 10
		hold.resolve(undefined)
		await running
		await expect(waiting).resolves.toBe('started')

		await expect(coordinator.run(() => {}, { key: 'A' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: 240,
		})
	})

	it('should prioritize expiry over a quota refill at the same decision', async () => {
		const { clock, coordinator } = createCoordinator({
			queue: { capacity: 1, concurrency: 1 },
		})
		await coordinator.run(() => {}, { key: 'A' })
		const expired = vi.fn()
		const waiting = coordinator.run(expired, { key: 'A', limitBehavior: 'enqueue', maxWaitMs: 10 })

		clock.monotonic = 10
		clock.epoch = 1000
		const fresh = vi.fn(() => 'fresh')
		const result = coordinator.run(fresh, { key: 'A' })

		expect(fresh).toHaveBeenCalledOnce()
		expect(expired).not.toHaveBeenCalled()
		await expect(waiting).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
		await expect(result).resolves.toBe('fresh')
	})

	it('should remove an aborted waiter before it can take a slot or debit quota', async () => {
		const { coordinator } = createCoordinator({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		const hold = Promise.withResolvers<undefined>()
		const active = coordinator.run(async () => await hold.promise, { key: 'A' })
		const controller = new AbortController()
		const cancelled = vi.fn()
		const waiting = coordinator.run(cancelled, { key: 'B', signal: controller.signal })
		controller.abort()
		await expect(waiting).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

		const next = coordinator.run(() => 'started', { key: 'B' })
		hold.resolve(undefined)
		await active
		await expect(next).resolves.toBe('started')
		expect(cancelled).not.toHaveBeenCalled()
	})
})
