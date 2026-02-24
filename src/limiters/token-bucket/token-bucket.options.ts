import { type TokenBucketState } from './token-bucket.state.js';
import { type RateLimiterOptions } from '../../interfaces/rate-limiter-options.js';

/**
 * Options for the Token Bucket rate limiter.
 */
export interface TokenBucketOptions extends RateLimiterOptions<TokenBucketState> {
	/**
	 * The maximum number of tokens that can be stored in the bucket.
	 */
	capacity: number;

	/**
	 * The rate, in seconds, at which tokens are refilled.
	 */
	refillRate: number;
}
