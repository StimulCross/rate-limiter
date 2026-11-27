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
}
