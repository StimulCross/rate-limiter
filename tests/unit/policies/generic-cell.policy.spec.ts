import { describe, expect, it } from 'vitest'
import { GenericCellPolicy } from '../../../src/limiters/generic-cell/generic-cell.policy.js'

describe('GenericCellPolicy', () => {
	it('should preserve the fractional phase of the outstanding TAT while replenishing a burst', () => {
		const profile = { intervalMs: 4, burst: 3 }
		const policy = new GenericCellPolicy([profile])

		expect(policy.getStatus(undefined, -0.25)).toEqual({
			nextAvailableAt: -0.25,
			profiles: [
				{ ...profile, tat: null, remaining: 3 },
			],
		})

		let state = policy.charge(undefined, -0.25)

		for (const remaining of [1, 0]) {
			expect(policy.check(state, -0.25)).toBeUndefined()
			state = policy.charge(state, -0.25)
			expect(policy.getStatus(state, -0.25).profiles[0]?.remaining).toBe(remaining)
		}

		expect(policy.check(state, 3.5)).toBe(3.75)
		expect(policy.getStatus(state, 7.5).profiles[0]?.remaining).toBe(1)
		expect(policy.getStatus(state, 7.75).profiles[0]).toEqual({ ...profile, tat: 11.75, remaining: 2 })
		expect(policy.check(state, 4)).toBeUndefined()
		state = policy.charge(state, 4)

		expect(policy.getStatus(state, 4)).toEqual({
			nextAvailableAt: 7.75,
			profiles: [
				{ ...profile, tat: 15.75, remaining: 0 },
			],
		})
	})

	it('should round an overflowing TAT and eligibility boundary to positive infinity', () => {
		const profile = { intervalMs: 1, burst: 1 }
		const policy = new GenericCellPolicy([profile])
		const time = Number.MAX_VALUE
		const state = policy.charge(undefined, time)

		expect(policy.check(state, time)).toBe(Infinity)

		expect(policy.getStatus(state, time)).toEqual({
			nextAvailableAt: Infinity,
			profiles: [
				{ ...profile, tat: Infinity, remaining: 0 },
			],
		})
	})
})
