import { type RateLimiterStatus } from '../../core/rate-limiter-status.js';

/**
 * The status of the Token Bucket rate limiter.
 */
export interface TokenBucketStatus extends RateLimiterStatus {
	/**
	 * The maximum number of tokens that can be stored in the bucket.
	 */
	capacity: number;

	/**
	 * The rate, in seconds, at which tokens are refilled.
	 */
	refillRate: number;

	/**
	 * The number of tokens available in the bucket.
	 */
	tokens: number;

	/**
	 * The number of tokens that have been reserved.
	 */
	debt: number;

	/**
	 * The timestamp (in milliseconds) at which next token will be available for use.
	 */
	nextAvailableAt: number;

	/**
	 * The timestamp (in milliseconds) at which the bucket will be reset.
	 */
	resetAt: number;
}
