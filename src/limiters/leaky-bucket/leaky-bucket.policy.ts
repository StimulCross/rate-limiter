import type { RateLimitPolicy } from '../../contracts/rate-limit-policy.js'
import type { LeakyBucketState } from './leaky-bucket.state.js'
import type { LeakyBucketStatus } from './leaky-bucket.status.js'
import { getNextTimestamp } from '../../utils/next-timestamp.js'

/** @internal */
export class LeakyBucketPolicy implements RateLimitPolicy<LeakyBucketState, LeakyBucketStatus> {
	constructor(private readonly _intervalMs: number) {
		if (!Number.isFinite(_intervalMs) || _intervalMs <= 0)
			throw new RangeError('Leaky Bucket interval must be positive and finite')
	}

	public check(state: LeakyBucketState | undefined, time: number): number | undefined {
		return state !== undefined && state.readyAt > time
			? state.readyAt
			: undefined
	}

	public charge(_state: LeakyBucketState | undefined, time: number): LeakyBucketState {
		const sum = time + this._intervalMs
		let readyAt = sum

		if (Number.isFinite(sum)) {
			const residual = Math.abs(time) >= this._intervalMs
				? this._intervalMs - (sum - time)
				: time - (sum - this._intervalMs)

			if (residual > 0)
				readyAt = getNextTimestamp(sum)
		}

		return { lastStartedAt: time, readyAt }
	}

	public getStatus(state: LeakyBucketState | undefined, time: number): LeakyBucketStatus {
		return {
			intervalMs: this._intervalMs,
			lastStartedAt: state?.lastStartedAt ?? null,
			nextAvailableAt: this.check(state, time) ?? time,
		}
	}
}
