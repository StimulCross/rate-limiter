import { type SlidingWindowCounterState } from './sliding-window-counter.state.js';
import { type SlidingWindowCounterStatus } from './sliding-window-counter.status.js';
import { type RateLimitPolicy, type RateLimitPolicyResult } from '../../core/rate-limit-policy.js';
import { validateCost } from '../../utils/validate-cost.js';

/** @internal */
export class SlidingWindowCounterPolicy implements RateLimitPolicy<
	SlidingWindowCounterState,
	SlidingWindowCounterStatus
> {
	constructor(
		private readonly _limit: number,
		private readonly _windowMs: number,
	) {
		if (!Number.isFinite(_limit) || !Number.isInteger(_limit) || _limit < 0) {
			throw new Error(`Invalid limit: ${_limit}. Must be a positive integer.`);
		}

		if (!Number.isFinite(_windowMs) || !Number.isInteger(_windowMs) || _windowMs <= 0) {
			throw new Error(`Invalid windowMs: ${_windowMs}. Must be a positive integer.`);
		}
	}

	public get limit(): number {
		return this._limit;
	}

	public get windowMs(): number {
		return this._windowMs;
	}

	public getInitialState(): SlidingWindowCounterState {
		return {
			windowStart: 0,
			currentCount: 0,
			previousCount: 0,
		};
	}

	public getStatus(state: SlidingWindowCounterState, now: number): SlidingWindowCounterStatus {
		const syncedState = this._syncState(state, now);
		const { windowStart, previousCount, currentCount } = syncedState;

		const timeIntoCurrentWindow = now - windowStart;
		const weight = (this._windowMs - timeIntoCurrentWindow) / this._windowMs;
		const estimatedCount = Math.floor(previousCount * weight + currentCount);

		const remaining = Math.max(0, this._limit - estimatedCount);

		const nextAvailableAt = this._calculateAvailableAt(windowStart, previousCount, currentCount, 1, now);

		let resetAt: number;

		if (currentCount > 0) {
			resetAt = windowStart + 2 * this._windowMs;
		} else if (previousCount > 0) {
			resetAt = windowStart + this._windowMs;
		} else {
			resetAt = now;
		}

		return {
			limit: this._limit,
			windowMs: this._windowMs,
			windowStart,
			currentCount,
			previousCount,
			estimatedCount,
			remaining,
			nextAvailableAt,
			resetAt,
		};
	}

	public evaluate(
		state: SlidingWindowCounterState,
		now: number,
		cost: number,
	): RateLimitPolicyResult<SlidingWindowCounterState> {
		validateCost(cost, this._limit);

		const syncedState = this._syncState(state, now);
		const { windowStart, previousCount, currentCount } = syncedState;

		const timeIntoCurrentWindow = now - windowStart;
		const weight = (this._windowMs - timeIntoCurrentWindow) / this._windowMs;
		const estimatedCount = Math.floor(previousCount * weight + currentCount);

		if (estimatedCount + cost <= this._limit) {
			return {
				decision: { kind: 'allow' },
				nextState: {
					windowStart,
					previousCount,
					currentCount: currentCount + cost,
				},
			};
		}

		const availableAt = this._calculateAvailableAt(windowStart, previousCount, currentCount, cost, now);

		return {
			decision: { kind: 'deny', retryAt: availableAt },
			nextState: syncedState,
		};
	}

	public revert(state: SlidingWindowCounterState, cost: number, now: number): SlidingWindowCounterState {
		if (cost <= 0) {
			return state;
		}

		const syncedState = this._syncState(state, now);

		return {
			...syncedState,
			currentCount: Math.max(0, syncedState.currentCount - cost),
		};
	}

	private _syncState(state: SlidingWindowCounterState, now: number): SlidingWindowCounterState {
		const currentWindowStart = Math.floor(now / this._windowMs) * this._windowMs;

		if (currentWindowStart <= state.windowStart) {
			return state;
		}

		const windowsPassed = Math.floor((currentWindowStart - state.windowStart) / this._windowMs);

		if (windowsPassed > 1) {
			return { windowStart: currentWindowStart, previousCount: 0, currentCount: 0 };
		}

		return {
			windowStart: currentWindowStart,
			previousCount: state.currentCount,
			currentCount: 0,
		};
	}

	private _calculateAvailableAt(windowStart: number, prev: number, curr: number, cost: number, now: number): number {
		if (curr + cost <= this._limit) {
			if (prev === 0) {
				return now;
			}

			const numerator = this._windowMs * (prev + curr + cost - this._limit - 1);
			const t = Math.max(0, Math.floor(numerator / prev) + 1);
			const absoluteTime = windowStart + t;

			return Math.max(now, absoluteTime);
		}

		const newPrev = curr;
		const newWindowStart = windowStart + this._windowMs;

		if (newPrev === 0) {
			return Math.max(now, newWindowStart);
		}

		const numerator = this._windowMs * (newPrev + cost - this._limit - 1);
		const t = Math.max(0, Math.floor(numerator / newPrev) + 1);
		const absoluteTime = newWindowStart + t;

		return Math.max(now, absoluteTime);
	}
}
