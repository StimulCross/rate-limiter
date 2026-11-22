import type { PriorityWeights } from '../../contracts/priority-weights.js'
import type { RateLimiterOptions } from '../../contracts/rate-limiter-options.js'
import type { HttpFeedbackExtractor } from './http-feedback.js'

/**
 * Configuration for one HTTP Response Based limiter instance.
 */
export interface HttpResponseBasedOptions<TResponse = unknown> extends RateLimiterOptions {
	/**
	 * Translates the client's response into normalized quota or throttling feedback.
	 */
	extractFeedback: HttpFeedbackExtractor<TResponse>

	/**
	 * Synchronously recovers a response from a client error, or returns null.
	 *
	 * `run()` still rejects with the original error.
	 */
	extractResponseFromError?: (error: unknown) => TResponse | null

	/**
	 * Positive finite cooldown in milliseconds for a 429 with no future retry timestamp.
	 *
	 * @default 60000
	 */
	fallbackResetDelayMs?: number

	/**
	 * Weights for global scheduling across keys.
	 *
	 * Defaults to `1`, `2`, `4`, `8`, and `16` from lowest to highest priority.
	 */
	weights?: PriorityWeights
}
