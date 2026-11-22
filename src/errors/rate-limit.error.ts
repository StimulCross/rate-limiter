import { RateLimitErrorCode } from './rate-limit-error-code.js'

/**
 * A rejection from the limiter before a callback starts.
 *
 * This error has a {@link code} property that indicates the type of error.
 *
 * The `code` can be:
 * - `LIMIT_EXCEEDED` - When the rate limit is exceeded.
 * - `QUEUE_OVERFLOW` - When the queue is full (if the limiter has a queue and the capacity has been exceeded).
 * - `EXPIRED` - When the task has expired (waited too long in the queue). This is related to the `maxWaitMs` option.
 * 			   **NOTE:** This is never thrown if the task is executing too long. Such scenarios should be handled by the
 * 			   task itself.
 * - `CLEARED` - When the task was waiting when its key was cleared.
 * - `DESTROYED` - When the limiter is shutting down or has shut down.
 * - `CANCELLED` - When the signal aborted before the callback started.
 */
export class RateLimitError extends Error {
	/**
	 * The reason the limiter rejected the task.
	 */
	public readonly code: RateLimitErrorCode

	/**
	 * Delay until a retry may become eligible, if known.
	 */
	public readonly retryAfterMs: number | null

	/**
	 * The task's diagnostic identifier, if supplied or generated.
	 */
	public readonly id: string | undefined

	/**
	 * Creates a rejection with an optional retry delay in milliseconds and diagnostic identifier.
	 */
	constructor(code: RateLimitErrorCode, retryAfterMs: number | null = null, id?: string) {
		let message: string

		switch (code) {
			case RateLimitErrorCode.LimitExceeded:
				message = `Rate limit exceeded.${retryAfterMs
					? ` Retry after ${retryAfterMs}ms.`
					: ''}`

				break

			case RateLimitErrorCode.QueueOverflow:
				message = 'Queue overflow.'

				break

			case RateLimitErrorCode.Expired:
				message = 'Task expired.'

				break

			case RateLimitErrorCode.Destroyed:
				message = 'Task destroyed.'

				break

			case RateLimitErrorCode.Cancelled:
				message = 'Task cancelled.'

				break

			case RateLimitErrorCode.Cleared:
				message = 'The limiter was cleared before the task was executed.'

				break

			default:
				message = 'Unknown error.'
		}

		super(message)

		this.name = 'RateLimitError'
		this.code = code
		this.retryAfterMs = retryAfterMs
		this.id = id

		Object.setPrototypeOf(this, new.target.prototype)
	}
}
