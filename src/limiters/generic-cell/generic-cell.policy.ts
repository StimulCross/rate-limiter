import { type GenericCellState } from './generic-cell.state.js';
import { type GenericCellStatus } from './generic-cell.status.js';
import { type RateLimitPolicy, type RateLimitPolicyResult } from '../../core/rate-limit-policy.js';
import { validateCost } from '../../utils/validate-cost.js';

/** @internal */
export class GenericCellPolicy implements RateLimitPolicy<GenericCellState, GenericCellStatus> {
	constructor(
		private readonly _intervalMs: number,
		private readonly _burst: number,
		private readonly _maxDelayMs: number = Number.POSITIVE_INFINITY,
	) {
		if (!Number.isFinite(_intervalMs) || !Number.isSafeInteger(_intervalMs) || _intervalMs <= 0) {
			throw new Error(`Invalid intervalMs: ${_intervalMs}. Must be a positive integer.`);
		}

		if (!Number.isFinite(_burst) || !Number.isSafeInteger(_burst) || _burst <= 0) {
			throw new Error(`Invalid burst: ${_burst}. Must be a positive integer.`);
		}

		if (_maxDelayMs < 0 || (!Number.isSafeInteger(_maxDelayMs) && _maxDelayMs !== Number.POSITIVE_INFINITY)) {
			throw new Error(`Invalid maxDelayMs: ${_maxDelayMs}. Must be a non-negative integer or Infinity.`);
		}
	}

	public get burst(): number {
		return this._burst;
	}

	public get intervalMs(): number {
		return this._intervalMs;
	}

	public getInitialState(): GenericCellState {
		return { tat: 0 };
	}

	public getStatus(state: GenericCellState, now: number): GenericCellStatus {
		const tat = Math.max(state.tat, now);
		const burstOffset = this._burst * this._intervalMs;

		const availableTimeDebt = burstOffset + now - tat;
		const remaining = Math.max(0, Math.floor(availableTimeDebt / this._intervalMs));

		const nextAvailableAt = Math.max(now, tat + this._intervalMs - burstOffset);

		const resetAt = tat;

		return {
			intervalMs: this._intervalMs,
			burst: this._burst,
			tat,
			remaining,
			nextAvailableAt,
			resetAt,
		};
	}

	public evaluate(
		state: GenericCellState,
		now: number,
		cost: number,
		shouldReserve?: boolean,
	): RateLimitPolicyResult<GenericCellState> {
		const absoluteMax = shouldReserve ? this._burst + Math.floor(this._maxDelayMs / this._intervalMs) : this._burst;

		validateCost(cost, absoluteMax);

		const tat = Math.max(state.tat, now);
		const costInterval = cost * this._intervalMs;
		const burstOffset = this._burst * this._intervalMs;

		const newTat = tat + costInterval;

		const minNow = newTat - burstOffset;

		if (now >= minNow) {
			return {
				decision: { kind: 'allow' },
				nextState: { tat: newTat },
			};
		}

		if (shouldReserve) {
			const waitMs = minNow - now;

			if (waitMs > this._maxDelayMs) {
				const retryAt = minNow - this._maxDelayMs;
				return this._deny(state.tat, retryAt);
			}

			const runAt = minNow;
			return {
				decision: { kind: 'delay', runAt },
				nextState: { tat: newTat },
			};
		}

		return this._deny(state.tat, minNow);
	}

	public revert(state: GenericCellState, cost: number): GenericCellState {
		const costInterval = cost * this._intervalMs;
		return {
			tat: Math.max(0, state.tat - costInterval),
		};
	}

	private _deny(tat: number, retryAt: number): RateLimitPolicyResult<GenericCellState> {
		return {
			decision: { kind: 'deny', retryAt },
			nextState: { tat },
		};
	}
}
