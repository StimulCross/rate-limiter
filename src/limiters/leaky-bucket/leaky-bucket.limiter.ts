import type { RateLimiterRunOptions } from '../../contracts/rate-limiter-run-options.js'
import type { RateLimiter } from '../../contracts/rate-limiter.js'
import type { LeakyBucketOptions } from './leaky-bucket-options.js'
import type { LeakyBucketState } from './leaky-bucket.state.js'
import type { LeakyBucketStatus } from './leaky-bucket.status.js'
import { RateLimiterCoordinator } from '../../runtime/rate-limiter-coordinator.js'
import { LeakyBucketPolicy } from './leaky-bucket.policy.js'

/**
 * Paces callback starts with an independent interval for each key.
 */
export class LeakyBucketLimiter implements RateLimiter<LeakyBucketStatus> {
	private readonly _coordinator: RateLimiterCoordinator<LeakyBucketState, LeakyBucketStatus>

	/**
	 * Creates a limiter with one pacing interval and optional bounded waiting.
	 */
	constructor(options: LeakyBucketOptions) {
		const { limitOptions, ...runtimeOptions } = options

		const policy = new LeakyBucketPolicy(limitOptions.intervalMs)
		this._coordinator = new RateLimiterCoordinator(policy, runtimeOptions, 'LeakyBucketLimiter')
	}

	/**
	 * Executes one callback when selected. A winning immediate callback starts synchronously.
	 */
	// eslint-disable-next-line ts/promise-function-async -- Return the promise that assimilates the original outcome.
	public run<T>(callback: () => T | PromiseLike<T>, options?: RateLimiterRunOptions): Promise<T> {
		return this._coordinator.run(callback, options)
	}

	/**
	 * Cancels pending work and resets pacing history for the given key, or for the entire instance.
	 *
	 * Running callbacks finish and keep their slots until settlement.
	 */
	public async clear(key?: string): Promise<void> {
		this._coordinator.clear(key)
	}

	/**
	 * Reads pacing status for the given key, or for the default key when omitted.
	 */
	public async getStatus(key?: string): Promise<LeakyBucketStatus> {
		return this._coordinator.getStatus(key)
	}

	/**
	 * Closes admission, cancels pending work, and waits for all running callbacks to settle.
	 */
	// eslint-disable-next-line ts/promise-function-async -- Preserve the shared shutdown promise.
	public destroy(): Promise<void> {
		return this._coordinator.destroy()
	}
}
