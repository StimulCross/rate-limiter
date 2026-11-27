import type { FixedResultRateLimiter, PriorityMode, RateLimiter, RateLimiterOptions } from '../../src/index.js'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { Priority, RateLimitError, RateLimitErrorCode } from '../../src/index.js'
import { HttpResponseBasedLimiter } from '../../src/limiters/http-response-based/index.js'
import { TokenBucketLimiter } from '../../src/limiters/token-bucket/index.js'

describe('root entry point', () => {
	it('should accept either limiter through a fixed-result contract with promise-like callbacks', async () => {
		const generic: RateLimiter = new TokenBucketLimiter({
			limitOptions: { capacity: 1, refillRate: 1 },
		})
		const limiters: FixedResultRateLimiter<Response>[] = [
			generic,
			new HttpResponseBasedLimiter<Response>({
				extractFeedback: () => null,
			}),
		]
		const response = new Response()
		const promise = Promise.resolve(response)
		const thenable: PromiseLike<Response> = {
			// eslint-disable-next-line unicorn/no-thenable -- Exercise a callback result that lacks the rest of the Promise API.
			then: promise.then.bind(promise),
		}

		for (const limiter of limiters) {
			const result = limiter.run(() => thenable)

			expectTypeOf(result).toEqualTypeOf<Promise<Response>>()
			await expect(result).resolves.toBe(response)
		}
	})

	it('should export the five priorities in ascending order', () => {
		expect([
			Priority.Lowest,
			Priority.Low,
			Priority.Normal,
			Priority.High,
			Priority.Highest,
		]).toEqual([1, 2, 3, 4, 5])
	})

	it('should export PriorityMode for the shared instance option', () => {
		expectTypeOf<PriorityMode>().toEqualTypeOf<'weighted' | 'strict'>()
		expectTypeOf<RateLimiterOptions['priorityMode']>().toEqualTypeOf<PriorityMode | undefined>()
	})

	it('should expose rate limit rejections as errors with the given reason and retry delay', () => {
		const error = new RateLimitError(RateLimitErrorCode.LimitExceeded, 100)

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('RateLimitError')
		expect(error.code).toBe('LIMIT_EXCEEDED')
		expect(error.retryAfterMs).toBe(100)
		expect(new RateLimitError(RateLimitErrorCode.Cancelled).retryAfterMs).toBeNull()
	})
})
