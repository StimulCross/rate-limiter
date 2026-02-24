import { type LeakyBucketState } from './leaky-bucket.state.js';
import { type LeakyBucketStatus } from './leaky-bucket.status.js';
import { type RateLimitPolicy, type RateLimitPolicyResult } from '../../core/rate-limit-policy.js';
import { validateCost } from '../../utils/validate-cost.js';

/** @internal */
export class LeakyBucketPolicy implements RateLimitPolicy<LeakyBucketState, LeakyBucketStatus> {
	constructor(
		private readonly _capacity: number,
		private readonly _leakRate: number,
		private readonly _maxOverflow: number = Number.POSITIVE_INFINITY,
	) {
		if (!Number.isFinite(_capacity) || !Number.isSafeInteger(_capacity) || _capacity <= 0) {
			throw new Error(`Invalid capacity: ${_capacity}. Must be a positive integer.`);
		}

		if (!Number.isFinite(_leakRate) || _leakRate <= 0) {
			throw new Error(`Invalid leakRate: ${_leakRate}. Must be a positive number.`);
		}

		if (_maxOverflow < 0 || (!Number.isSafeInteger(_maxOverflow) && _maxOverflow !== Number.POSITIVE_INFINITY)) {
			throw new Error(`Invalid maxOverflow: ${_maxOverflow}. Must be a non-negative integer or Infinity.`);
		}
	}

	public get capacity(): number {
		return this._capacity;
	}

	public get leakRate(): number {
		return this._leakRate;
	}

	public getInitialState(): LeakyBucketState {
		return { level: 0, lastUpdate: 0 };
	}

	public getStatus(state: LeakyBucketState, now: number): LeakyBucketStatus {
		const { level } = this._syncState(state, now);

		const volumeToClearForOne = Math.max(0, level + 1 - this._capacity);
		const nextAvailableAt =
			volumeToClearForOne === 0 ? now : now + Math.ceil((volumeToClearForOne / this._leakRate) * 1000);

		const resetAt = level === 0 ? now : now + Math.ceil((level / this._leakRate) * 1000);

		return {
			capacity: this._capacity,
			leakRate: this._leakRate,
			level,
			remaining: Math.max(0, this._capacity - level),
			nextAvailableAt,
			resetAt,
		};
	}

	public evaluate(
		state: LeakyBucketState,
		now: number,
		cost: number,
		shouldReserve?: boolean,
	): RateLimitPolicyResult<LeakyBucketState> {
		validateCost(cost, this._capacity);

		const { level, lastUpdate } = this._syncState(state, now);
		const nextLevel = level + cost;

		if (nextLevel <= this._capacity) {
			return {
				decision: { kind: 'allow' },
				nextState: { level: nextLevel, lastUpdate },
			};
		}

		const overflow = nextLevel - this._capacity;

		if (shouldReserve) {
			if (overflow > this._maxOverflow) {
				const volumeToLeak = nextLevel - (this._capacity + this._maxOverflow);
				const waitMs = Math.ceil((volumeToLeak / this._leakRate) * 1000);
				const retryAt = now + waitMs;

				return this._deny(level, lastUpdate, retryAt);
			}

			const waitMs = Math.ceil((overflow / this._leakRate) * 1000);
			const runAt = now + waitMs;

			return {
				decision: { kind: 'delay', runAt },
				nextState: { level: nextLevel, lastUpdate },
			};
		}

		const waitMs = Math.ceil((overflow / this._leakRate) * 1000);
		const retryAt = now + waitMs;

		return this._deny(level, lastUpdate, retryAt);
	}

	public revert(state: LeakyBucketState, cost: number, now: number): LeakyBucketState {
		const { level, lastUpdate } = this._syncState(state, now);

		return {
			level: Math.max(0, level - cost),
			lastUpdate,
		};
	}

	private _deny(level: number, lastUpdate: number, retryAt: number): RateLimitPolicyResult<LeakyBucketState> {
		return {
			decision: { kind: 'deny', retryAt },
			nextState: { level, lastUpdate },
		};
	}

	private _syncState(state: LeakyBucketState, now: number): LeakyBucketState {
		if (state.lastUpdate === 0) {
			return { level: 0, lastUpdate: now };
		}

		if (now <= state.lastUpdate) {
			return state;
		}

		const elapsedMs = now - state.lastUpdate;
		const leaked = (elapsedMs / 1000) * this._leakRate;

		return {
			level: Math.max(0, state.level - leaked),
			lastUpdate: now,
		};
	}
}
