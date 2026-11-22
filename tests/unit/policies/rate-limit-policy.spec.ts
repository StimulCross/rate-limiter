import type { RateLimitPolicy } from '../../../src/contracts/rate-limit-policy.js'
import { describe, expect, it } from 'vitest'
import { FixedWindowPolicy } from '../../../src/limiters/fixed-window/fixed-window.policy.js'
import { GenericCellPolicy } from '../../../src/limiters/generic-cell/generic-cell.policy.js'
import { LeakyBucketPolicy } from '../../../src/limiters/leaky-bucket/leaky-bucket.policy.js'
import { SlidingWindowCounterPolicy } from '../../../src/limiters/sliding-window-counter/sliding-window-counter.policy.js'
import { SlidingWindowLogPolicy } from '../../../src/limiters/sliding-window-log/sliding-window-log.policy.js'
import { TokenBucketPolicy } from '../../../src/limiters/token-bucket/token-bucket.policy.js'

function testPolicy<State>(name: string, policy: RateLimitPolicy<State, { nextAvailableAt: number }>) {
	describe(name, () => {
		it('should report readiness at the Unix epoch and leave quota unchanged after projecting past it', () => {
			expect(policy.check(undefined, -100)).toBeUndefined()
			expect(policy.getStatus(undefined, -100).nextAvailableAt).toBe(-100)
			const state = policy.charge(undefined, -100)
			const blocked = policy.getStatus(state, -1)
			expect(blocked.nextAvailableAt).toBe(0)
			expect(policy.check(state, -1)).toBe(0)

			expect(policy.check(state, 100)).toBeUndefined()
			expect(policy.getStatus(state, 100).nextAvailableAt).toBe(100)

			expect(policy.check(state, -1)).toBe(0)
			expect(policy.getStatus(state, -1)).toEqual(blocked)
			expect(policy.check(state, 0)).toBeUndefined()
			expect(policy.getStatus(state, 0).nextAvailableAt).toBe(0)

			const restarted = policy.charge(state, 0)
			expect(policy.check(restarted, 0)).toBe(100)
			expect(policy.getStatus(restarted, 0).nextAvailableAt).toBe(100)
		})

		it('should keep histories started on different keys independent', () => {
			const first = policy.charge(undefined, -100)
			expect(policy.check(undefined, 0)).toBeUndefined()
			const second = policy.charge(undefined, 0)
			const before = policy.getStatus(second, 0)
			expect(before.nextAvailableAt).toBe(100)

			expect(policy.check(first, -1)).toBe(0)
			expect(policy.check(first, 0)).toBeUndefined()
			const restarted = policy.charge(first, 0)
			expect(policy.check(restarted, 100)).toBeUndefined()
			policy.charge(restarted, 100)

			expect(policy.check(second, 0)).toBe(100)
			expect(policy.getStatus(second, 0)).toEqual(before)
		})
	})
}

describe('RateLimitPolicy contract', () => {
	testPolicy('Fixed Window (first start)', new FixedWindowPolicy([
		{ limit: 1, windowMs: 100 },
	]))

	testPolicy('Fixed Window (grid)', new FixedWindowPolicy([
		{ alignment: 'grid', limit: 1, windowMs: 100 },
	]))

	testPolicy('Generic Cell', new GenericCellPolicy([
		{ intervalMs: 100, burst: 1 },
	]))

	testPolicy('Leaky Bucket', new LeakyBucketPolicy(100))
	testPolicy('Sliding Window Counter', new SlidingWindowCounterPolicy({ limit: 1, windowMs: 50 }))

	testPolicy('Sliding Window Log', new SlidingWindowLogPolicy([
		{ limit: 1, windowMs: 100 },
	]))

	testPolicy('Token Bucket', new TokenBucketPolicy([
		{ capacity: 1, refillRate: 10 },
	]))
})
