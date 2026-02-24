import { type FixedWindowState } from './fixed-window.state.js';
import { type FixedWindowStatus } from './fixed-window.status.js';
import { type RateLimitPolicy, type RateLimitPolicyResult } from '../../core/rate-limit-policy.js';
import { validateCost } from '../../utils/validate-cost.js';

/** @internal */
export class FixedWindowPolicy implements RateLimitPolicy<FixedWindowState, FixedWindowStatus> {
	constructor(
		private readonly _limit: number,
		private readonly _windowMs: number,
		private readonly _maxReserved: number = Number.POSITIVE_INFINITY,
	) {
		if (!Number.isSafeInteger(_limit) || _limit <= 0) {
			throw new Error(`Invalid limit: ${_limit}. Must be a positive integer.`);
		}

		if (!Number.isSafeInteger(_windowMs) || _windowMs <= 0) {
			throw new Error(`Invalid windowMs: ${_windowMs}. Must be a positive integer.`);
		}

		if (_maxReserved < 0 || (_maxReserved !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(_maxReserved))) {
			throw new Error(`Invalid maxReserved: ${_maxReserved}. Must be a positive integer or Infinity.`);
		}
	}

	public get limit(): number {
		return this._limit;
	}

	public get windowMs(): number {
		return this._windowMs;
	}

	public getInitialState(): FixedWindowState {
		return { windowStart: 0, used: 0, reserved: 0 };
	}

	public getStatus(state: FixedWindowState, now: number): FixedWindowStatus {
		const { windowStart, used, reserved } = this._syncState(state, now);
		const windowEnd = windowStart + this._windowMs;

		let nextAvailableAt: number;

		if (used < this._limit) {
			nextAvailableAt = windowStart;
		} else {
			const blockedWindows = Math.floor((used + reserved) / this._limit);
			nextAvailableAt = windowStart + blockedWindows * this._windowMs;
		}

		const windowsToClear = Math.ceil((used + reserved) / this._limit);
		const resetAt = windowStart + Math.max(1, windowsToClear) * this._windowMs;

		return {
			windowStart,
			windowEnd,
			limit: this._limit,
			used,
			reserved,
			remaining: Math.max(0, this._limit - used),
			nextAvailableAt,
			resetAt,
		};
	}

	public evaluate(
		state: FixedWindowState,
		now: number,
		cost: number,
		shouldReserve?: boolean,
	): RateLimitPolicyResult<FixedWindowState> {
		validateCost(cost, this._limit);

		const { windowStart, used, reserved } = this._syncState(state, now);
		const currentTotal = used + cost;

		if (reserved === 0 && currentTotal <= this._limit) {
			return {
				decision: { kind: 'allow' },
				nextState: { windowStart, used: currentTotal, reserved: 0 },
			};
		}

		if (shouldReserve) {
			if (reserved + cost > this._maxReserved) {
				const deficit = reserved + cost - this._maxReserved;
				const windowsToWait = Math.ceil(deficit / this._limit);
				const retryAt = windowStart + Math.max(1, windowsToWait) * this._windowMs;

				return this._deny(windowStart, used, reserved, retryAt);
			}

			const totalItems = used + reserved + cost;
			const windowIndex = Math.floor((totalItems - 1) / this._limit);
			const runAt = windowStart + windowIndex * this._windowMs;

			return {
				decision: { kind: 'delay', runAt },
				nextState: {
					windowStart,
					used,
					reserved: reserved + cost,
				},
			};
		}

		const windowsToWait = Math.ceil((used + reserved + cost - this._limit) / this._limit);
		const retryAt = windowStart + Math.max(1, windowsToWait) * this._windowMs;

		return this._deny(windowStart, used, reserved, retryAt);
	}

	public revert(state: FixedWindowState, cost: number, now: number): FixedWindowState {
		let { used, reserved, windowStart } = this._syncState(state, now);

		if (reserved >= cost) {
			reserved -= cost;
		} else {
			const remainder = cost - reserved;
			reserved = 0;
			used = Math.max(0, used - remainder);
		}

		return { windowStart, used, reserved };
	}

	private _deny(
		start: number,
		used: number,
		reserved: number,
		retryAt: number,
	): RateLimitPolicyResult<FixedWindowState> {
		return {
			decision: { kind: 'deny', retryAt },
			nextState: { windowStart: start, used, reserved },
		};
	}

	private _syncState(state: FixedWindowState, now: number): FixedWindowState {
		const currentWindowStart = Math.max(Math.floor(now / this._windowMs) * this._windowMs, state.windowStart);

		if (currentWindowStart <= state.windowStart) {
			return state;
		}

		let { reserved } = state;
		const windowsPassed = Math.floor((currentWindowStart - state.windowStart) / this._windowMs);
		const burnableWindows = windowsPassed - 1;

		if (burnableWindows > 0 && reserved > 0) {
			reserved = Math.max(0, reserved - burnableWindows * this._limit);
		}

		const used = Math.min(reserved, this._limit);
		reserved = Math.max(0, reserved - used);

		return { windowStart: currentWindowStart, used, reserved };
	}
}
