import type { TokenBucketState } from '../../../src/limiters/token-bucket/token-bucket.state.js'
import { describe, expect, it } from 'vitest'
import { TokenBucketPolicy } from '../../../src/limiters/token-bucket/token-bucket.policy.js'

function chargeStart(policy: TokenBucketPolicy, state: TokenBucketState | undefined, time: number) {
	expect(policy.check(state, time)).toBeUndefined()

	return policy.charge(state, time)
}

describe('TokenBucketPolicy', () => {
	it('should start full and cap the burst after a long idle period', () => {
		const profile = { capacity: 3, refillRate: 2 }
		const policy = new TokenBucketPolicy([profile])

		expect(policy.getStatus(undefined, 0)).toEqual({
			nextAvailableAt: 0,
			profiles: [
				{ ...profile, tokens: 3 },
			],
		})

		let state: TokenBucketState | undefined

		for (const time of [0, 10_000]) {
			for (const tokens of [2, 1, 0]) {
				state = chargeStart(policy, state, time)
				expect(policy.getStatus(state, time).profiles[0]?.tokens).toBe(tokens)
			}

			expect(policy.check(state, time)).toBe(time + 500)
		}
	})

	it('should accumulate fractional refill across charges and admit at one token', () => {
		const policy = new TokenBucketPolicy([
			{ capacity: 5, refillRate: 2 },
		])
		let state: TokenBucketState | undefined

		for (const time of [0, 1, 2, 3, 4])
			state = chargeStart(policy, state, time)

		expect(policy.getStatus(state, 499).profiles[0]?.tokens).toBe(0.998)
		expect(policy.check(state, 499)).toBe(500)

		state = chargeStart(policy, state, 500)
		expect(policy.getStatus(state, 500).profiles[0]?.tokens).toBe(0)
		expect(policy.check(state, 500)).toBe(1000)
	})

	it('should use the latest profile availability and preserve state until every profile passes', () => {
		const slow = { capacity: 1, refillRate: 1 }
		const fast = { capacity: 1, refillRate: 4 }
		const policy = new TokenBucketPolicy([slow, fast])
		let state = chargeStart(policy, undefined, 0)
		const before = structuredClone(state)

		expect(policy.check(state, 0)).toBe(1000)
		expect(policy.check(state, 250)).toBe(1000)

		expect(policy.getStatus(state, 250)).toEqual({
			nextAvailableAt: 1000,
			profiles: [
				{ ...slow, tokens: 0.25 },
				{ ...fast, tokens: 1 },
			],
		})

		expect(state).toEqual(before)

		state = chargeStart(policy, state, 1000)
		expect(policy.getStatus(state, 1000).profiles.map(profile => profile.tokens)).toEqual([0, 0])
		expect(policy.check(state, 1000)).toBe(2000)
	})

	it('should project future refill without rebasing the stored charge', () => {
		const policy = new TokenBucketPolicy([
			{ capacity: 1, refillRate: 2.5 },
		])
		const state = chargeStart(policy, undefined, 100)

		expect(policy.getStatus(state, 10_000).profiles[0]?.tokens).toBe(1)
		expect(policy.getStatus(state, 200).profiles[0]?.tokens).toBe(0.25)
		expect(policy.check(state, 499)).toBe(500)
		expect(policy.check(state, 500)).toBeUndefined()
	})

	it('should discard fractional surplus when refill reaches capacity before a charge', () => {
		const profile = { capacity: 2, refillRate: 2 }
		const policy = new TokenBucketPolicy([profile])
		let state = chargeStart(policy, undefined, 0)

		expect(policy.getStatus(state, 750).profiles).toEqual([
			{ ...profile, tokens: 2 },
		])

		state = chargeStart(policy, state, 750)

		expect(policy.getStatus(state, 750).profiles).toEqual([
			{ ...profile, tokens: 1 },
		])

		state = chargeStart(policy, state, 750)

		expect(policy.check(state, 1249)).toBe(1250)
		expect(policy.check(state, 1250)).toBeUndefined()
	})

	it('should retain a finite refill boundary when elapsed time exceeds the finite range', () => {
		const boundary = 2 ** 1023
		const profile = { capacity: 1, refillRate: 1000 * 2 ** -1024 }
		const policy = new TokenBucketPolicy([profile])
		let state = chargeStart(policy, undefined, -boundary)

		expect(policy.getStatus(state, 0)).toEqual({
			nextAvailableAt: boundary,
			profiles: [
				{ ...profile, tokens: 0.5 },
			],
		})

		expect(policy.check(state, boundary / 2)).toBe(boundary)
		state = chargeStart(policy, state, boundary)

		expect(policy.getStatus(state, boundary).profiles).toEqual([
			{ ...profile, tokens: 0 },
		])

		expect(policy.check(state, boundary)).toBe(Infinity)
	})

	it('should stay blocked at the representable predecessor of the refill boundary', () => {
		const boundary = 2 ** 1023
		const policy = new TokenBucketPolicy([
			{ capacity: 1, refillRate: 1000 * 2 ** -1024 },
		])
		const state = policy.charge(undefined, -boundary)
		// Refill takes 2 ** 1024 ms, so the exact first eligible timestamp is +boundary.
		const predecessor = boundary - 2 ** 970

		expect(policy.check(state, predecessor)).toBe(boundary)
		expect(policy.getStatus(state, predecessor).nextAvailableAt).toBe(boundary)
		expect(policy.check(state, boundary)).toBeUndefined()
	})

	it('should report unreachable refill for a rate below the finite timestamp range', () => {
		const policy = new TokenBucketPolicy([
			{ capacity: 1, refillRate: Number.MIN_VALUE },
		])
		const state = chargeStart(policy, undefined, 0)

		expect(policy.check(state, 0)).toBe(Infinity)
		expect(policy.check(state, Number.MAX_VALUE)).toBe(Infinity)
		expect(policy.getStatus(state, Number.MAX_VALUE).nextAvailableAt).toBe(Infinity)
	})
})
