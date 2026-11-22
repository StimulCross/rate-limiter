/**
 * API-specific quota evidence from a single callback outcome.
 */
export type HttpFeedback =
	| {
		/**
		 * A server quota snapshot.
		 */
		readonly kind: 'quota'

		/**
		 * Post-request remaining units as a nonnegative safe integer.
		 */
		readonly remaining: number

		/**
		 * Finite Unix epoch milliseconds identifying the server window's reset.
		 */
		readonly resetAt: number
	}
	| {
		/**
		 * An HTTP 429 response, including clients that reject on HTTP errors.
		 */
		readonly kind: 'rate-limited'

		/**
		 * Earliest retry time in Unix epoch milliseconds. Omit when unavailable.
		 */
		readonly retryAt?: number
	}

/**
 * Synchronously extracts feedback from the response, or returns `null` if none is available.
 *
 * The response is `null` when the callback yields no response.
 *
 * The effective settlement time is in Unix epoch milliseconds.
 * Convert relative reset and retry delays using the API's header semantics.
 */
export type HttpFeedbackExtractor<TResponse = unknown> = (
	response: TResponse | null,
	settledAt: number,
) => HttpFeedback | null
