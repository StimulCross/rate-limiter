import { type RateLimiterStatus } from '../../core/rate-limiter-status.js';

/**
 * The status of the Leaky Bucket rate limiter.
 */
export interface LeakyBucketStatus extends RateLimiterStatus {
	/**
	 * The maximum capacity of the bucket (maximum number of requests that can be queued).
	 */
	capacity: number;

	/**
	 * The rate at which requests leak from the bucket (requests per second).
	 */
	leakRate: number;

	/**
	 * The current number of requests in the bucket waiting to be processed.
	 */
	level: number;

	/**
	 * The number of requests that can still be added to the bucket before reaching capacity.
	 */
	remaining: number;

	/**
	 * Timestamp (in milliseconds) when the next request slot will become available.
	 */
	nextAvailableAt: number;

	/**
	 * Timestamp (in milliseconds) when all queued requests will have leaked (bucket becomes empty).
	 */
	resetAt: number;
}
