import { type LeakyBucketState } from './leaky-bucket.state.js';
import { type RateLimiterOptions } from '../../interfaces/rate-limiter-options.js';

/**
 * Options for the Leaky Bucket rate limiter.
 */
export interface LeakyBucketOptions extends RateLimiterOptions<LeakyBucketState> {
	/**
	 * The maximum number of requests that can be queued in the bucket.
	 *
	 * In the Leaky Bucket algorithm, this represents the maximum depth of the bucket
	 * that holds incoming requests before they leak out at a constant rate.
	 */
	capacity: number;

	/**
	 * The rate at which requests are processed from the bucket (requests per second).
	 *
	 * This defines the constant rate at which requests "leak" out of the bucket
	 * and are allowed to proceed.
	 */
	leakRate: number;
}
