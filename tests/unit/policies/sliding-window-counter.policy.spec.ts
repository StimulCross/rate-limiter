import { describe, expect, it } from 'vitest'
import { SlidingWindowCounterPolicy } from '../../../src/limiters/sliding-window-counter/sliding-window-counter.policy.js'

describe('SlidingWindowCounterPolicy', () => {
	it.each([
		{ limit: 0, windowMs: 1000 },
		{ limit: 1.5, windowMs: 1000 },
		{ limit: 2 ** 53, windowMs: 1000 },
		{ limit: 1, windowMs: 0 },
		{ limit: 1, windowMs: Infinity },
		{ limit: 1, windowMs: 1000, offsetMs: 0.5 },
		{ limit: 1, windowMs: 1000, offsetMs: 2 ** 53 },
	])('should reject invalid options %j', options => {
		expect(() => new SlidingWindowCounterPolicy(options)).toThrow(RangeError)
	})

	it.each([
		{ offsetMs: 0, start: 990, boundary: 1000 },
		{ offsetMs: 250, start: -750.5, boundary: -750 },
	])('should project adjacent and skipped windows from a start at $start', ({ offsetMs, start, boundary }) => {
		const policy = new SlidingWindowCounterPolicy({ limit: 5, windowMs: 1000, offsetMs })
		const state = policy.charge(policy.charge(undefined, start), start)

		expect(policy.getStatus(state, start)).toMatchObject({
			windowStart: boundary - 1000,
			currentCount: 2,
			previousCount: 0,
		})

		expect(policy.getStatus(state, boundary)).toEqual({
			limit: 5,
			windowMs: 1000,
			windowStart: boundary,
			currentCount: 0,
			previousCount: 2,
			estimatedCount: 2,
			remaining: 3,
			nextAvailableAt: boundary,
		})

		expect(policy.getStatus(state, boundary + 1000)).toMatchObject({
			windowStart: boundary + 1000,
			currentCount: 0,
			previousCount: 0,
			estimatedCount: 0,
			remaining: 5,
		})
	})

	it('should block an estimate of 4.5 until it reaches four', () => {
		const policy = new SlidingWindowCounterPolicy({ limit: 5, windowMs: 1000 })
		let state = policy.charge(undefined, 990)

		for (let count = 1; count < 5; count++)
			state = policy.charge(state, 990)

		expect(policy.getStatus(state, 1100)).toMatchObject({ estimatedCount: 4.5, remaining: 0, nextAvailableAt: 1200 })
		expect(policy.check(state, 1199)).toBe(1200)
		expect(policy.check(state, 1200)).toBeUndefined()
		expect(policy.getStatus(state, 1200)).toMatchObject({ estimatedCount: 4, remaining: 1, nextAvailableAt: 1200 })

		state = policy.charge(state, 1200)
		expect(policy.getStatus(state, 1200)).toMatchObject({ currentCount: 1, previousCount: 5, nextAvailableAt: 1400 })
	})

	it('should remain blocked through rollover when the limit is one', () => {
		const policy = new SlidingWindowCounterPolicy({ limit: 1, windowMs: 1000 })
		const state = policy.charge(undefined, 990)

		expect(policy.getStatus(state, 1000)).toMatchObject({ currentCount: 0, previousCount: 1, nextAvailableAt: 2000 })
		expect(policy.check(state, 1999)).toBe(2000)
		expect(policy.check(state, 2000)).toBeUndefined()
	})

	it('should carry only the latest count into the previous window on a second rollover', () => {
		const policy = new SlidingWindowCounterPolicy({ limit: 3, windowMs: 1000 })
		let state = policy.charge(policy.charge(undefined, 0), 0)

		expect(policy.check(state, 1000)).toBeUndefined()
		state = policy.charge(state, 1000)
		expect(policy.check(state, 1499)).toBe(1500)
		expect(policy.check(state, 1500)).toBeUndefined()
		state = policy.charge(state, 1500)

		expect(policy.check(state, 1999)).toBe(2000)
		expect(policy.check(state, 2000)).toBeUndefined()
		state = policy.charge(state, 2000)

		expect(policy.getStatus(state, 2000)).toMatchObject({
			windowStart: 2000,
			currentCount: 1,
			previousCount: 2,
			estimatedCount: 3,
			remaining: 0,
			nextAvailableAt: 2500,
		})
	})

	it.each([
		{ boundary: 1000, ulp: 2 ** -42 },
		{ boundary: -1000, ulp: 2 ** -43 },
	])('should return the first representable time after the rational threshold from $boundary', ({ boundary, ulp }) => {
		const policy = new SlidingWindowCounterPolicy({ limit: 3, windowMs: 1000 })
		const start = boundary - 10
		const state = policy.charge(policy.charge(policy.charge(undefined, start), start), start)
		const { nextAvailableAt } = policy.getStatus(state, boundary)
		const predecessor = nextAvailableAt - ulp

		// Convert the timestamps to integer multiples of their ULP and test 3 * (t - boundary) >= 1000.
		const reference = (time: number) => 3n * (BigInt(time / ulp) - BigInt(boundary / ulp)) >= BigInt(1000 / ulp)

		expect(reference(predecessor)).toBe(false)
		expect(reference(nextAvailableAt)).toBe(true)
		expect(policy.check(state, predecessor)).toBe(nextAvailableAt)
		expect(policy.check(state, nextAvailableAt)).toBeUndefined()
	})

	it('should compute remaining before rounding a displayed estimate to four', () => {
		const policy = new SlidingWindowCounterPolicy({ limit: 5, windowMs: 1 })
		let state = policy.charge(undefined, -0.5)

		for (let count = 1; count < 5; count++)
			state = policy.charge(state, -0.5)

		expect(policy.getStatus(state, 0.2 - 2 ** -55)).toMatchObject({
			estimatedCount: 4,
			remaining: 0,
			nextAvailableAt: 0.2,
		})

		expect(policy.getStatus(state, 0.2)).toMatchObject({ estimatedCount: 4, remaining: 1 })
	})

	it('should classify windows exactly when the grid index exceeds the safe integer range', () => {
		const policy = new SlidingWindowCounterPolicy({ limit: 1, windowMs: 0.5, offsetMs: -1 })
		const start = 2 ** 52
		const state = policy.charge(undefined, start)

		expect(policy.check(state, start)).toBe(start + 1)
		expect(policy.getStatus(state, start + 1)).toMatchObject({ currentCount: 0, previousCount: 0, remaining: 1 })
	})

	it('should handle subnormal durations and an overflowing threshold', () => {
		const policy = new SlidingWindowCounterPolicy({ limit: 1, windowMs: Number.MIN_VALUE })
		const state = policy.charge(undefined, -Number.MIN_VALUE)

		expect(policy.getStatus(state, 0)).toMatchObject({ currentCount: 0, previousCount: 1, nextAvailableAt: Number.MIN_VALUE })
		expect(policy.check(state, Number.MIN_VALUE)).toBeUndefined()
		expect(policy.check(policy.charge(undefined, Number.MAX_VALUE), Number.MAX_VALUE)).toBe(Infinity)
	})
})
