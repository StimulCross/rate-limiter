import type { LimitBehavior } from './limit-behavior.js'
import type { Priority } from './priority.js'

/**
 * Options shared by all limiter algorithms.
 */
export interface RateLimiterRunOptions {
	/**
	 * Diagnostic task identifier.
	 */
	id?: string

	/**
	 * Quota key.
	 *
	 * Quota is independent per key. Local execution resources may be shared.
	 */
	key?: string

	/**
	 * Overrides the limiter's default behavior.
	 * - `reject` forbids waiting for quota or concurrency.
	 * - `enqueue` permits bounded waiting. A finite capacity must be configured.
	 */
	limitBehavior?: LimitBehavior

	/**
	 * Selection priority. Does not preempt running tasks or bypass capacity/quota.
	 *
	 * Five weighted priority classes compete among offered tasks.
	 * Start order does not guarantee completion order.
	 *
	 * @default {@link Priority.Normal}
	 */
	priority?: Priority

	/**
	 * Prevents starting a pending task after cancellation.
	 *
	 * Cancellation of an already running operation is the callback's responsibility.
	 *
	 * Cancellation before the callback starts does not spend quota.
	 * Once started, the callback's quota is not refunded.
	 */
	signal?: AbortSignal

	/**
	 * Maximum time from run to callback start, in milliseconds.
	 * Overrides the limiter's waiting deadline, not an execution timeout.
	 *
	 * `0` permits only an immediate start.
	 */
	maxWaitMs?: number
}
