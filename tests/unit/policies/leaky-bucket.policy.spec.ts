import { describe, expect, it } from 'vitest'
import { LeakyBucketPolicy } from '../../../src/limiters/leaky-bucket/leaky-bucket.policy.js'

describe('LeakyBucketPolicy', () => {
	it('should allow the first start and pace from each actual start after idle time or clock rollback', () => {
		const policy = new LeakyBucketPolicy(100)

		expect(policy.check(undefined, 0)).toBeUndefined()
		const initial = policy.charge(undefined, 0)
		expect(policy.check(initial, 99)).toBe(100)
		expect(policy.check(initial, 100)).toBeUndefined()
		expect(policy.check(initial, 50)).toBe(100)
		expect(policy.check(initial, 1000)).toBeUndefined()

		const afterIdle = policy.charge(initial, 1000)
		expect(policy.check(afterIdle, 1000)).toBe(1100)
		expect(policy.check(afterIdle, 1100)).toBeUndefined()
	})

	it.each([
		{ start: 0.25, interval: 0.5, readyAt: 0.75 },
		{ start: 2 ** 40, interval: 2 ** -14, readyAt: 2 ** 40 + 2 ** -12 },
		{ start: 2 ** 40, interval: 3 * 2 ** -14, readyAt: 2 ** 40 + 2 ** -12 },
		{ start: Number.MIN_VALUE, interval: 1, readyAt: 1 + Number.EPSILON },
		{ start: -1, interval: Number.MIN_VALUE, readyAt: -1 + Number.EPSILON / 2 },
	])('should round $start + $interval upward to $readyAt', ({ start, interval, readyAt }) => {
		const policy = new LeakyBucketPolicy(interval)
		const state = policy.charge(undefined, start)

		expect(policy.check(state, start)).toBe(readyAt)
		expect(policy.check(state, readyAt)).toBeUndefined()
	})

	it.each([Number.MIN_VALUE, Number.MAX_VALUE])('should keep the key blocked when adding %s exceeds the finite range', interval => {
		const policy = new LeakyBucketPolicy(interval)
		const state = policy.charge(undefined, Number.MAX_VALUE)

		expect(policy.check(state, Number.MAX_VALUE)).toBe(Infinity)
	})

	it.each([0, -1, NaN, Infinity])('should reject invalid interval %s', interval => {
		expect(() => new LeakyBucketPolicy(interval)).toThrow(RangeError)
	})
})
