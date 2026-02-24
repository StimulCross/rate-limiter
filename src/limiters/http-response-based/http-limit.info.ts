/**
 * Rate limit information extracted from the HTTP response headers.
 */
export interface HttpLimitInfo {
	/**
	 * The maximum number of requests allowed within the time window.
	 *
	 * It usually corresponds to `RateLimit-Limit` or `X-RateLimit-Limit` headers.
	 */
	limit: number;

	/**
	 * The number of requests remaining in the current time window.
	 *
	 * It usually corresponds to `RateLimit-Remaining` or `X-RateLimit-Remaining` headers.
	 */
	remaining: number;

	/**
	 * The timestamp (in milliseconds) when the current time window resets.
	 *
	 * It usually corresponds to `RateLimit-Reset`, `X-RateLimit-Reset`, or `Retry-After` headers.
	 *
	 * **WARNING:** these headers can be either delta (usually in seconds) or UNIX epoche
	 * timestamp (usually in seconds) depending on the target API specs.
	 *
	 *The library expects a UNIX epoche timestamp in milliseconds. Refer to the API docs to
	 * determine the header format and properly convert it to UNIX epoche timestamp in milliseconds.
	 *
	 * For example,
	 *   - delta in seconds: `Date.now() + delta * 1000`
	 *   - UNIX timestamp in seconds: `timestamp * 1000`
	 *
	 */
	resetAt?: number | null;

	/**
	 * HTTP status code of the response.
	 */
	statusCode: number;
}
