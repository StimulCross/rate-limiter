import type { RateLimiterRunOptions } from '../../contracts/rate-limiter-run-options.js'
import type { RateLimiter } from '../../contracts/rate-limiter.js'
import type { SlidingWindowLogOptions } from './sliding-window-log.options.js'
import type { SlidingWindowLogState } from './sliding-window-log.state.js'
import type { SlidingWindowLogStatus } from './sliding-window-log.status.js'
import { RateLimiterCoordinator } from '../../runtime/rate-limiter-coordinator.js'
import { SlidingWindowLogPolicy } from './sliding-window-log.policy.js'

/**
 * Limits callback starts using a separate sliding history of actual starts for each key.
 */
export class SlidingWindowLogLimiter implements RateLimiter<SlidingWindowLogStatus> {
	private readonly _coordinator: RateLimiterCoordinator<SlidingWindowLogState, SlidingWindowLogStatus>

	/**
	 * Creates a limiter with one or more sliding window profiles and optional bounded waiting.
	 */
	constructor(options: SlidingWindowLogOptions) {
		const { limitOptions, ...runtimeOptions } = options

		const policy = new SlidingWindowLogPolicy('limit' in limitOptions
			? [limitOptions]
			: limitOptions)

		this._coordinator = new RateLimiterCoordinator(policy, runtimeOptions, 'SlidingWindowLogLimiter')
	}

	/**
	 * Executes one callback when selected. A winning immediate callback starts synchronously.
	 */
	// eslint-disable-next-line ts/promise-function-async -- Return the promise that assimilates the original outcome.
	public run<T>(callback: () => T | PromiseLike<T>, options?: RateLimiterRunOptions): Promise<T> {
		return this._coordinator.run(callback, options)
	}

	/**
	 * Cancels pending work and clears history for the given key, or for the entire instance.
	 *
	 * Running callbacks finish and keep their slots until settlement.
	 */
	public async clear(key?: string): Promise<void> {
		this._coordinator.clear(key)
	}

	/**
	 * Reads quota status for the given key, or for the default key when omitted.
	 */
	public async getStatus(key?: string): Promise<SlidingWindowLogStatus> {
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
