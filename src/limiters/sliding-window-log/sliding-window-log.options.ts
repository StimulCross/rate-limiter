import { type SlidingWindowLogState } from './sliding-window-log.state.js';
import { type RateLimiterOptions } from '../../interfaces/rate-limiter-options.js';

/**
 * Options for the Sliding Window Log rate limiter.
 */
export interface SlidingWindowLogOptions extends Omit<
	RateLimiterOptions<SlidingWindowLogState>,
	'queue' | 'limitBehavior'
> {
	/**
	 * Maximum number of requests allowed within the time window.
	 */
	limit: number;

	/**
	 * Duration of the time window in milliseconds.
	 */
	windowMs: number;
}
