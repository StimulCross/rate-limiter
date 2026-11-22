import type { FixedWindowState } from '../../../src/limiters/fixed-window/fixed-window.state.js'
import { describe, expect, it } from 'vitest'
import { FixedWindowPolicy } from '../../../src/limiters/fixed-window/fixed-window.policy.js'

function chargeStart(policy: FixedWindowPolicy, state: FixedWindowState | undefined, now: number) {
	expect(policy.check(state, now)).toBeUndefined()

	return policy.charge(state, now)
}

describe('FixedWindowPolicy', () => {
	it('should open a first-start window at zero and reopen only on the next start after expiry', () => {
		const policy = new FixedWindowPolicy([
			{ limit: 3, windowMs: 1000 },
		])

		expect(policy.getStatus(undefined, -100).profiles).toEqual([
			{
				window: null,
				limit: 3,
				used: 0,
				remaining: 3,
			},
		])

		let state = chargeStart(policy, undefined, 0)
		state = chargeStart(policy, state, 0)
		state = chargeStart(policy, state, 999)
		expect(policy.check(state, 999)).toBe(1000)

		expect(policy.getStatus(state, 999).profiles[0]).toEqual({
			window: { start: 0, end: 1000 },
			limit: 3,
			used: 3,
			remaining: 0,
		})

		expect(policy.getStatus(state, 1000).profiles[0]).toEqual({
			window: null,
			limit: 3,
			used: 0,
			remaining: 3,
		})

		expect(policy.check(state, 1000)).toBeUndefined()

		state = chargeStart(policy, state, 2500)
		state = chargeStart(policy, state, 2500)
		expect(policy.check(state, 2500)).toBeUndefined()

		expect(policy.getStatus(state, 2500).profiles[0]).toEqual({
			window: { start: 2500, end: 3500 },
			limit: 3,
			used: 2,
			remaining: 1,
		})
	})

	it('should admit a full grid window on either side of a boundary', () => {
		const policy = new FixedWindowPolicy([
			{ alignment: 'grid', limit: 2, windowMs: 1000 },
		])

		expect(policy.getStatus(undefined, 999).profiles[0]).toEqual({
			window: { start: 0, end: 1000 },
			limit: 2,
			used: 0,
			remaining: 2,
		})

		let state = chargeStart(policy, undefined, 999)
		state = chargeStart(policy, state, 999)
		expect(policy.check(state, 999)).toBe(1000)

		state = chargeStart(policy, state, 1000)
		state = chargeStart(policy, state, 1000)
		expect(policy.check(state, 1000)).toBe(2000)
		expect(policy.getStatus(state, 1000).profiles[0]?.window).toEqual({ start: 1000, end: 2000 })
	})

	it.each(['first-start', 'grid'] as const)('should discard unused quota at a %s window boundary', alignment => {
		const policy = new FixedWindowPolicy([
			{ alignment, limit: 2, windowMs: 1000 },
		])
		const state = chargeStart(policy, undefined, 0)
		expect(policy.getStatus(state, 999).profiles[0]?.remaining).toBe(1)
		expect(policy.getStatus(state, 1000).profiles[0]?.remaining).toBe(2)

		const next = chargeStart(policy, state, 1000)
		const filled = chargeStart(policy, next, 1000)
		expect(policy.check(filled, 1000)).toBe(2000)
	})

	it('should align timestamps before the offset to the preceding grid window', () => {
		const policy = new FixedWindowPolicy([
			{
				alignment: 'grid',
				offsetMs: 25,
				limit: 1,
				windowMs: 1000,
			},
		])
		let state = chargeStart(policy, undefined, 0)

		expect(policy.getStatus(state, 0).profiles[0]?.window).toEqual({ start: -975, end: 25 })
		expect(policy.check(state, 24)).toBe(25)
		state = chargeStart(policy, state, 25)
		expect(policy.check(state, 25)).toBe(1025)
	})

	it('should retain fractional grid boundaries', () => {
		const policy = new FixedWindowPolicy([
			{ alignment: 'grid', limit: 1, windowMs: 0.25 },
		])
		let state = chargeStart(policy, undefined, 0.125)

		expect(policy.check(state, 0.125)).toBe(0.25)
		state = chargeStart(policy, state, 0.25)
		expect(policy.check(state, 0.25)).toBe(0.5)
	})

	it.each([-0.125, 0.375, 1.375])('should preserve the same grid for an equivalent fractional offset of %s', offsetMs => {
		const policy = new FixedWindowPolicy([
			{
				alignment: 'grid',
				limit: 1,
				windowMs: 0.5,
				offsetMs,
			},
		])
		let state = chargeStart(policy, undefined, -0.25)

		expect(policy.getStatus(state, -0.25).profiles[0]?.window).toEqual({ start: -0.625, end: -0.125 })
		expect(policy.check(state, -0.25)).toBe(-0.125)
		state = chargeStart(policy, state, -0.125)
		expect(policy.getStatus(state, -0.125).profiles[0]?.window).toEqual({ start: -0.125, end: 0.375 })
		expect(policy.check(state, -0.125)).toBe(0.375)
	})

	it.each(['first-start', 'grid'] as const)('should retain %s usage across clock rollback', alignment => {
		const policy = new FixedWindowPolicy([
			{ alignment, limit: 1, windowMs: 1000 },
		])
		let state = chargeStart(policy, undefined, 0)
		state = chargeStart(policy, state, 1000)

		expect(policy.check(state, 0)).toBe(2000)

		expect(policy.getStatus(state, 0)).toEqual({
			nextAvailableAt: 2000,
			profiles: [
				{
					window: { start: 1000, end: 2000 },
					limit: 1,
					used: 1,
					remaining: 0,
				},
			],
		})
	})

	it('should admit a start at a rounded fractional grid boundary', () => {
		const policy = new FixedWindowPolicy([
			{ alignment: 'grid', limit: 1, windowMs: 1.1 },
		])
		let state = chargeStart(policy, undefined, 16)

		expect(policy.check(state, 16)).toBe(16.5)
		state = chargeStart(policy, state, 16.5)
		expect(policy.getStatus(state, 16.5).profiles[0]?.window?.start).toBe(16.5)
		expect(policy.check(state, 16.5)).toBe(17.6)
	})

	it('should leave later admission unchanged after observing a future window', () => {
		const policy = new FixedWindowPolicy([
			{ limit: 1, windowMs: 1000 },
		])
		const observed = chargeStart(policy, undefined, 100)
		const unobserved = chargeStart(policy, undefined, 100)

		expect(policy.getStatus(observed, 2500)).toEqual({
			nextAvailableAt: 2500,
			profiles: [
				{
					window: null,
					limit: 1,
					used: 0,
					remaining: 1,
				},
			],
		})

		expect(policy.check(observed, 500)).toBe(1100)
		expect(policy.check(observed, 500)).toBe(policy.check(unobserved, 500))

		expect(policy.getStatus(chargeStart(policy, observed, 1100), 1100)).toEqual(
			policy.getStatus(chargeStart(policy, unobserved, 1100), 1100),
		)
	})

	it('should keep all profiles intact when the longer profile denies a start', () => {
		const policy = new FixedWindowPolicy([
			{ limit: 1, windowMs: 1000 },
			{ limit: 1, windowMs: 5000 },
		])
		let state = chargeStart(policy, undefined, 100)
		const beforeDenial = structuredClone(state)

		expect(policy.check(state, 100)).toBe(5100)
		expect(policy.check(state, 1200)).toBe(5100)
		expect(state).toEqual(beforeDenial)

		expect(policy.getStatus(state, 1200)).toEqual({
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

		state = chargeStart(policy, state, 5100)

		expect(policy.getStatus(state, 5100).profiles).toEqual([
			{
				window: { start: 5100, end: 6100 },
				limit: 1,
				used: 1,
				remaining: 0,
			},
			{
				window: { start: 5100, end: 10_100 },
				limit: 1,
				used: 1,
				remaining: 0,
			},
		])
	})

	it('should charge both profiles when one rolls over and the other stays active', () => {
		const policy = new FixedWindowPolicy([
			{ limit: 2, windowMs: 5000 },
			{ alignment: 'grid', limit: 1, windowMs: 1000 },
		])
		const otherKey = chargeStart(policy, undefined, 100)
		let state = chargeStart(policy, undefined, 100)

		state = chargeStart(policy, state, 1000)
		expect(policy.check(state, 1000)).toBe(5100)

		expect(policy.getStatus(state, 1000)).toEqual({
			nextAvailableAt: 5100,
			profiles: [
				{
					window: { start: 100, end: 5100 },
					limit: 2,
					used: 2,
					remaining: 0,
				},
				{
					window: { start: 1000, end: 2000 },
					limit: 1,
					used: 1,
					remaining: 0,
				},
			],
		})

		expect(policy.check(otherKey, 1000)).toBeUndefined()
	})

	it('should reject invalid quota configuration', () => {
		expect(() => new FixedWindowPolicy([])).toThrow(RangeError)

		expect(() => new FixedWindowPolicy([
			{ limit: 0.5, windowMs: 1000 },
		])).toThrow(RangeError)

		expect(() => new FixedWindowPolicy([
			{ limit: 1, windowMs: 0 },
		])).toThrow(RangeError)

		expect(() => new FixedWindowPolicy([
			{
				alignment: 'grid',
				limit: 1,
				windowMs: 1000,
				offsetMs: Number.NaN,
			},
		])).toThrow(RangeError)
	})
})
