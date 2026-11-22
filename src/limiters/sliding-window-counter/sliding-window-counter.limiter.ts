import type { RateLimiterRunOptions } from '../../contracts/rate-limiter-run-options.js'
import type { RateLimiter } from '../../contracts/rate-limiter.js'
import type { SlidingWindowCounterOptions } from './sliding-window-counter.options.js'
import type { SlidingWindowCounterState } from './sliding-window-counter.state.js'
import type { SlidingWindowCounterStatus } from './sliding-window-counter.status.js'
import { RateLimiterCoordinator } from '../../runtime/rate-limiter-coordinator.js'
import { SlidingWindowCounterPolicy } from './sliding-window-counter.policy.js'

/**
 * Limits callback starts per key using an estimate from two adjacent grid windows.
 */
export class SlidingWindowCounterLimiter implements RateLimiter<SlidingWindowCounterStatus> {
	private readonly _coordinator: RateLimiterCoordinator<SlidingWindowCounterState, SlidingWindowCounterStatus>

	/**
	 * Creates a limiter with one grid horizon and optional bounded waiting.
	 */
	constructor(options: SlidingWindowCounterOptions) {
		const { limitOptions, ...runtimeOptions } = options

		const policy = new SlidingWindowCounterPolicy(limitOptions)
		this._coordinator = new RateLimiterCoordinator(policy, runtimeOptions, 'SlidingWindowCounterLimiter')
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
	public async getStatus(key?: string): Promise<SlidingWindowCounterStatus> {
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
