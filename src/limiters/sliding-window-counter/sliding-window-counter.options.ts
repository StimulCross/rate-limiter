import { type SlidingWindowCounterState } from './sliding-window-counter.state.js';
import { type RateLimiterOptions } from '../../interfaces/rate-limiter-options.js';

/**
 * Options for the Sliding Window Counter rate limiter.
 */
export interface SlidingWindowCounterOptions extends Omit<
	RateLimiterOptions<SlidingWindowCounterState>,
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
