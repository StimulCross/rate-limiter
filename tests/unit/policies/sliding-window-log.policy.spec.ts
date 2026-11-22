import type { SlidingWindowLogState } from '../../../src/limiters/sliding-window-log/sliding-window-log.state.js'
import { describe, expect, it } from 'vitest'
import { SlidingWindowLogPolicy } from '../../../src/limiters/sliding-window-log/sliding-window-log.policy.js'

function chargeStart(policy: SlidingWindowLogPolicy, history: SlidingWindowLogState | undefined, time: number) {
	expect(policy.check(history, time)).toBeUndefined()

	return policy.charge(history, time)
}

describe('SlidingWindowLogPolicy', () => {
	it('should count each start at zero and expire simultaneous starts at their boundary', () => {
		const policy = new SlidingWindowLogPolicy([
			{ limit: 2, windowMs: 1000 },
		])

		expect(policy.getStatus(undefined, 0)).toEqual({
			nextAvailableAt: 0,
			profiles: [
				{
					limit: 2,
					windowMs: 1000,
					used: 0,
					remaining: 2,
				},
			],
		})

		let history = chargeStart(policy, undefined, 0)
		history = chargeStart(policy, history, 0)
		expect(policy.getStatus(history, 999).profiles[0]?.used).toBe(2)
		expect(policy.check(history, 999)).toBe(1000)
		expect(policy.getStatus(history, 1000).profiles[0]?.used).toBe(0)

		history = chargeStart(policy, history, 1000)
		expect([...history]).toEqual([1000])
		expect(policy.getStatus(history, 1000).profiles[0]?.remaining).toBe(1)
	})

	it('should prune only the starts that have expired for every profile when charging', () => {
		const policy = new SlidingWindowLogPolicy([
			{ limit: 2, windowMs: 100 },
			{ limit: 4, windowMs: 250 },
		])
		let history: SlidingWindowLogState | undefined

		for (const time of [0, 10, 100, 110])
			history = chargeStart(policy, history, time)

		expect(policy.check(history, 111)).toBe(250)
		expect(policy.check(history, 200)).toBe(250)
		expect(policy.getStatus(history, 200).profiles.map(profile => profile.used)).toEqual([1, 4])

		history = chargeStart(policy, history, 250)
		expect([...history]).toEqual([10, 100, 110, 250])
		expect(policy.getStatus(history, 250).profiles.map(profile => profile.used)).toEqual([1, 4])
		expect(policy.check(history, 250)).toBe(260)

		history = chargeStart(policy, history, 260)
		expect([...history]).toEqual([100, 110, 250, 260])
		expect(policy.check(history, 260)).toBe(350)
	})

	it('should leave history intact when a longer profile denies a start or status projects expiry', () => {
		const policy = new SlidingWindowLogPolicy([
			{ limit: 1, windowMs: 100 },
			{ limit: 1, windowMs: 1000 },
		])
		const history = chargeStart(policy, undefined, 100)

		expect(policy.check(history, 250)).toBe(1100)
		expect(policy.getStatus(history, 250).profiles.map(profile => profile.used)).toEqual([0, 1])
		expect(policy.getStatus(history, 1200).profiles.map(profile => profile.used)).toEqual([0, 0])
		expect([...history]).toEqual([100])
		expect(policy.check(history, 150)).toBe(1100)
		expect(policy.getStatus(history, 150).profiles.map(profile => profile.used)).toEqual([1, 1])
	})

	it('should expire a fractional window that crosses timestamp zero', () => {
		const policy = new SlidingWindowLogPolicy([
			{ limit: 1, windowMs: 0.5 },
		])
		const history = chargeStart(policy, undefined, -0.25)

		expect(policy.check(history, 0)).toBe(0.25)
		expect(policy.getStatus(history, 0).profiles[0]?.used).toBe(1)
		expect(policy.check(history, 0.25)).toBeUndefined()
		expect(policy.getStatus(history, 0.25).profiles[0]?.used).toBe(0)
	})

	it('should use the oldest active start of a full short window even when older history is retained', () => {
		const policy = new SlidingWindowLogPolicy([
			{ limit: 5, windowMs: 100 },
			{ limit: 2, windowMs: 10 },
		])
		let history: SlidingWindowLogState | undefined

		for (const time of [0, 10, 20, 21])
			history = chargeStart(policy, history, time)

		expect(policy.getStatus(history, 29)).toEqual({
			nextAvailableAt: 30,
			profiles: [
				{
					limit: 5,
					windowMs: 100,
					used: 4,
					remaining: 1,
				},
				{
					limit: 2,
					windowMs: 10,
					used: 2,
					remaining: 0,
				},
			],
		})

		expect(policy.check(history, 29)).toBe(30)
		history = chargeStart(policy, history, 30)
		expect(policy.check(history, 30)).toBe(100)
		expect(policy.getStatus(history, 31).profiles.map(profile => profile.remaining)).toEqual([0, 1])
	})

	it('should keep a start active when its expiry exceeds the finite timestamp range', () => {
		const policy = new SlidingWindowLogPolicy([
			{ limit: 1, windowMs: Number.MIN_VALUE },
		])
		const history = chargeStart(policy, undefined, Number.MAX_VALUE)

		expect(policy.check(history, Number.MAX_VALUE)).toBe(Infinity)

		expect(policy.getStatus(history, Number.MAX_VALUE)).toEqual({
			nextAvailableAt: Infinity,
			profiles: [
				{
					limit: 1,
					windowMs: Number.MIN_VALUE,
					used: 1,
					remaining: 0,
				},
			],
		})
	})
})
