import type { RateLimiterRunOptions } from '../../contracts/rate-limiter-run-options.js'
import type { RateLimiter } from '../../contracts/rate-limiter.js'
import type { GenericCellOptions } from './generic-cell.options.js'
import type { GenericCellState } from './generic-cell.state.js'
import type { GenericCellStatus } from './generic-cell.status.js'
import { RateLimiterCoordinator } from '../../runtime/rate-limiter-coordinator.js'
import { GenericCellPolicy } from './generic-cell.policy.js'

/**
 * Limits callback starts with independent Generic Cell Rate Algorithm (GCRA) quotas per key.
 */
export class GenericCellLimiter implements RateLimiter<GenericCellStatus> {
	private readonly _coordinator: RateLimiterCoordinator<GenericCellState, GenericCellStatus>

	/**
	 * Creates a limiter with one or more GCRA profiles and optional bounded waiting.
	 */
	constructor(options: GenericCellOptions) {
		const { limitOptions, ...runtimeOptions } = options

		const policy = new GenericCellPolicy('intervalMs' in limitOptions
			? [limitOptions]
			: limitOptions)

		this._coordinator = new RateLimiterCoordinator(policy, runtimeOptions, 'GenericCellLimiter')
	}

	/**
	 * Executes one callback when selected. A winning immediate callback starts synchronously.
	 */
	// eslint-disable-next-line ts/promise-function-async -- Return the promise that assimilates the original outcome.
	public run<T>(callback: () => T | PromiseLike<T>, options?: RateLimiterRunOptions): Promise<T> {
		return this._coordinator.run(callback, options)
	}

	/**
	 * Cancels pending work and resets quota for the given key, or for the entire instance.
	 *
	 * Running callbacks finish and keep their slots until settlement.
	 */
	public async clear(key?: string): Promise<void> {
		this._coordinator.clear(key)
	}

	/**
	 * Reads quota status for the given key, or for the default key when omitted.
	 */
	public async getStatus(key?: string): Promise<GenericCellStatus> {
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
