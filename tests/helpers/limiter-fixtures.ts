import type { RateLimiterOptions } from '../../src/index.js'
import { FixedWindowLimiter } from '../../src/limiters/fixed-window/index.js'
import { GenericCellLimiter } from '../../src/limiters/generic-cell/index.js'
import { HttpResponseBasedLimiter } from '../../src/limiters/http-response-based/index.js'
import { LeakyBucketLimiter } from '../../src/limiters/leaky-bucket/index.js'
import { SlidingWindowCounterLimiter } from '../../src/limiters/sliding-window-counter/index.js'
import { SlidingWindowLogLimiter } from '../../src/limiters/sliding-window-log/index.js'
import { TokenBucketLimiter } from '../../src/limiters/token-bucket/index.js'

// After the first start at t=0, each fixture reopens quota at t=100.
export const limiterFixtures = [
	{
		name: 'Fixed Window',
		create: (options: RateLimiterOptions) =>
			new FixedWindowLimiter({
				...options,
				limitOptions: { limit: 1, windowMs: 100 },
			}),
	},
	{
		name: 'Generic Cell',
		create: (options: RateLimiterOptions) =>
			new GenericCellLimiter({
				...options,
				limitOptions: { burst: 1, intervalMs: 100 },
			}),
	},
	{
		name: 'HTTP Response Based',
		create: (options: RateLimiterOptions) =>
			new HttpResponseBasedLimiter({
				...options,
				// Timestamp results report an exhausted budget until 100 ms after the start.
				extractFeedback: response => typeof response === 'number'
					? { kind: 'quota', remaining: 0, resetAt: response + 100 }
					: null,
			}),
	},
	{
		name: 'Leaky Bucket',
		create: (options: RateLimiterOptions) =>
			new LeakyBucketLimiter({
				...options,
				limitOptions: { intervalMs: 100 },
			}),
	},
	{
		name: 'Sliding Window Counter',
		create: (options: RateLimiterOptions) =>
			new SlidingWindowCounterLimiter({
				...options,
				limitOptions: { limit: 1, windowMs: 50 },
			}),
	},
	{
		name: 'Sliding Window Log',
		create: (options: RateLimiterOptions) =>
			new SlidingWindowLogLimiter({
				...options,
				limitOptions: { limit: 1, windowMs: 100 },
			}),
	},
	{
		name: 'Token Bucket',
		create: (options: RateLimiterOptions) =>
			new TokenBucketLimiter({
				...options,
				limitOptions: { capacity: 1, refillRate: 10 },
			}),
	},
]
