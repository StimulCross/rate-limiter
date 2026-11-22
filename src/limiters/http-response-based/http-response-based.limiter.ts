import type { RateLimiterRunOptions } from '../../contracts/rate-limiter-run-options.js'
import type { FixedResultRateLimiter } from '../../contracts/rate-limiter.js'
import type { HttpResponseBasedOptions } from './http-response-based.options.js'
import type { HttpResponseState } from './http-response-based.state.js'
import type { HttpResponseBasedStatus } from './http-response-based.status.js'
import { RateLimiterCoordinator } from '../../runtime/rate-limiter-coordinator.js'
import { HttpResponsePolicy } from './http-response.policy.js'

/**
 * Limits local starts for one API-defined, fixed-reset quota scope per key.
 *
 * Each callback spends one server quota unit. A callback's original result
 * or rejection is returned once, including HTTP 429 outcomes.
 */
export class HttpResponseBasedLimiter<TResponse = unknown> implements FixedResultRateLimiter<TResponse, HttpResponseBasedStatus> {
	private readonly _coordinator: RateLimiterCoordinator<HttpResponseState, HttpResponseBasedStatus, TResponse>

	/**
	 * Creates a limiter with API-specific feedback, local admission and optional bounded waiting.
	 */
	constructor(options: HttpResponseBasedOptions<TResponse>) {
		const { extractFeedback, extractResponseFromError, fallbackResetDelayMs, ...runtimeOptions } = options
		const policy = new HttpResponsePolicy(extractFeedback, extractResponseFromError, fallbackResetDelayMs)
		this._coordinator = new RateLimiterCoordinator(policy, runtimeOptions, 'HttpResponseBasedLimiter')
	}

	/**
	 * Starts one callback when eligible and returns its original outcome.
	 *
	 * A winning immediate callback starts synchronously.
	 */
	// eslint-disable-next-line ts/promise-function-async -- Return the promise that assimilates the original outcome.
	public run(callback: () => TResponse | PromiseLike<TResponse>, options?: RateLimiterRunOptions): Promise<TResponse> {
		return this._coordinator.run(callback, options)
	}

	/**
	 * Clears quota and cancels waiting tasks for one key, or for the entire instance.
	 *
	 * Running callbacks retain their slots and settle without updating the cleared state.
	 */
	public async clear(key?: string): Promise<void> {
		this._coordinator.clear(key)
	}

	/**
	 * Observes quota for the given key, or the default key when omitted.
	 */
	public async getStatus(key?: string): Promise<HttpResponseBasedStatus> {
		return this._coordinator.getStatus(key)
	}

	/**
	 * Closes admission, cancels waiting tasks, and waits for running callbacks to settle.
	 */
	// eslint-disable-next-line ts/promise-function-async -- Preserve the shared shutdown promise.
	public destroy(): Promise<void> {
		return this._coordinator.destroy()
	}
}
