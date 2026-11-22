import type { RateLimiterRunOptions } from '../../contracts/rate-limiter-run-options.js'
import type { RateLimiter } from '../../contracts/rate-limiter.js'
import type { TokenBucketOptions } from './token-bucket.options.js'
import type { TokenBucketState } from './token-bucket.state.js'
import type { TokenBucketStatus } from './token-bucket.status.js'
import { RateLimiterCoordinator } from '../../runtime/rate-limiter-coordinator.js'
import { TokenBucketPolicy } from './token-bucket.policy.js'

/**
 * Limits callback starts with independent Token Bucket quotas per key.
 */
export class TokenBucketLimiter implements RateLimiter<TokenBucketStatus> {
	private readonly _coordinator: RateLimiterCoordinator<TokenBucketState, TokenBucketStatus>

	/**
	 * Creates a limiter with one or more initially full profiles and optional bounded waiting.
	 */
	constructor(options: TokenBucketOptions) {
		const { limitOptions, ...runtimeOptions } = options

		const policy = new TokenBucketPolicy('capacity' in limitOptions ? [limitOptions] : limitOptions)
		this._coordinator = new RateLimiterCoordinator(policy, runtimeOptions, 'TokenBucketLimiter')
	}

	/**
	 * Executes one callback when selected. A winning immediate callback starts synchronously.
	 */
	// eslint-disable-next-line ts/promise-function-async -- Return the promise that assimilates the original outcome.
	public run<T>(callback: () => T | PromiseLike<T>, options?: RateLimiterRunOptions): Promise<T> {
		return this._coordinator.run(callback, options)
	}

	/**
	 * Cancels pending work and restores full quota for the given key, or for the entire instance.
	 *
	 * Running callbacks finish and keep their slots until settlement.
	 */
	public async clear(key?: string): Promise<void> {
		this._coordinator.clear(key)
	}

	/**
	 * Reads quota status for the given key, or for the default key when omitted.
	 */
	public async getStatus(key?: string): Promise<TokenBucketStatus> {
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
