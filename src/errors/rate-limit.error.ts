import { RateLimitErrorCode } from '../enums/rate-limit-error-code.js';

export interface RateLimitErrorPlainObject extends Error {
	code: RateLimitErrorCode;
	retryAt: number | null;
}

/**
 * An error thrown when a rate limit is exceeded.
 *
 * This error has a {@link code} property that indicates the type of error.
 *
 * The `code` can be:
 * - `LIMIT_EXCEEDED` - When the rate limit is exceeded.
 * - `QUEUE_OVERFLOW` - When the queue is full (if the limiter has a queue and the capacity has been exceeded).
 * - `EXPIRED` - When the task has expired (waited too long in the queue). This is related to the `maxWaitMs` option.
 *			   **NOTE:** This is never thrown if the task is executing too long. Such scenarios should be handled by the
 *			   task itself.
 * - `DESTROYED` - When the task is destroyed due to the rate limiter's `clear()` or `destroy()` methods.
 * - `CANCELLED` - When the task is cancelled using an abort signal.
 */
export class RateLimitError extends Error {
	private readonly _code: RateLimitErrorCode;
	private readonly _retryAt: number | null;

	/** @internal */
	constructor(code: RateLimitErrorCode, retryAt?: number, message?: string) {
		if (!message) {
			switch (code) {
				case RateLimitErrorCode.LimitExceeded: {
					message = `Rate limit exceeded.${retryAt ? ` Retry at ${new Date(retryAt).toISOString()}.` : ''}`;
					break;
				}

				case RateLimitErrorCode.QueueOverflow: {
					message = 'Queue overflow.';
					break;
				}

				case RateLimitErrorCode.Expired: {
					message = 'Task expired.';
					break;
				}

				case RateLimitErrorCode.Destroyed: {
					message = 'Task destroyed.';
					break;
				}

				case RateLimitErrorCode.Cancelled: {
					message = 'Task cancelled.';
					break;
				}

				// No default
			}
		}

		super(message);

		this._code = code;
		this._retryAt = retryAt ?? null;
	}

	/**
	 * The error code.
	 */
	public get code(): RateLimitErrorCode {
		return this._code;
	}

	/**
	 * The timestamp (in milliseconds) when the task can be retried.
	 *
	 * Can be `null` if the retry time is not known.
	 */
	public get retryAt(): number | null {
		return this._retryAt ?? null;
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	public toJSON(): RateLimitErrorPlainObject {
		return {
			name: this.name,
			message: this.message,
			code: this._code,
			retryAt: this._retryAt,
			stack: this.stack,
		};
	}
}
