import { Deque } from '@stimulcross/ds-deque';
import { type SlidingWindowLogEntry, type SlidingWindowLogState } from './sliding-window-log.state.js';
import { type SlidingWindowLogStatus } from './sliding-window-log.status.js';
import { type RateLimitPolicy, type RateLimitPolicyResult } from '../../core/rate-limit-policy.js';
import { validateCost } from '../../utils/validate-cost.js';

/** @internal */
export class SlidingWindowLogPolicy implements RateLimitPolicy<SlidingWindowLogState, SlidingWindowLogStatus> {
	constructor(
		private readonly _limit: number,
		private readonly _windowMs: number,
	) {
		if (!Number.isFinite(_limit) || !Number.isInteger(_limit) || _limit <= 0) {
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

	public getInitialState(): SlidingWindowLogState {
		return {
			logs: new Deque<SlidingWindowLogEntry>(),
			totalUsed: 0,
		};
	}

	public getStatus(state: SlidingWindowLogState, now: number): SlidingWindowLogStatus {
		const syncedState = this._syncState(state, now);
		const { logs, totalUsed } = syncedState;

		const remaining = Math.max(0, this._limit - totalUsed);

		const nextAvailableAt = this._calculateAvailableAt(logs, totalUsed, 1, now);

		const tail = logs.peekTail();
		const resetAt = tail ? tail.ts + this._windowMs : now;

		return {
			limit: this._limit,
			windowMs: this._windowMs,
			totalUsed,
			remaining,
			nextAvailableAt,
			resetAt,
		};
	}

	public evaluate(
		state: SlidingWindowLogState,
		now: number,
		cost: number,
	): RateLimitPolicyResult<SlidingWindowLogState> {
		validateCost(cost, this._limit);

		const syncedState = this._syncState(state, now);
		const { logs, totalUsed } = syncedState;

		if (totalUsed + cost <= this._limit) {
			const tail = logs.peekTail();

			if (tail?.ts === now) {
				tail.count += cost;
			} else {
				logs.push({ ts: now, count: cost });
			}

			return {
				decision: { kind: 'allow' },
				nextState: { logs, totalUsed: totalUsed + cost },
			};
		}

		const retryAt = this._calculateAvailableAt(logs, totalUsed, cost, now);

		return {
			decision: { kind: 'deny', retryAt },
			nextState: syncedState,
		};
	}

	public revert(state: SlidingWindowLogState, cost: number, now: number): SlidingWindowLogState {
		if (cost <= 0 || state.totalUsed === 0) {
			return state;
		}

		const syncedState = this._syncState(state, now);
		const { logs } = syncedState;
		let { totalUsed } = syncedState;

		let remainingToRemove = cost;

		while (remainingToRemove > 0 && !logs.isEmpty) {
			const tail = logs.peekTail()!;

			if (tail.count <= remainingToRemove) {
				remainingToRemove -= tail.count;
				totalUsed -= tail.count;
				logs.pop();
			} else {
				tail.count -= remainingToRemove;
				totalUsed -= remainingToRemove;
				remainingToRemove = 0;
			}
		}

		return { logs, totalUsed: Math.max(0, totalUsed) };
	}

	private _syncState(state: SlidingWindowLogState, now: number): SlidingWindowLogState {
		const { logs } = state;
		let { totalUsed } = state;
		const windowStart = now - this._windowMs;

		while (!logs.isEmpty) {
			const head = logs.peekHead();

			if (head!.ts > windowStart) {
				break;
			}

			const removed = logs.shift();

			if (removed) {
				totalUsed -= removed.count;
			}
		}

		return { logs, totalUsed: Math.max(0, totalUsed) };
	}

	private _calculateAvailableAt(
		logs: Deque<SlidingWindowLogEntry>,
		totalUsed: number,
		cost: number,
		now: number,
	): number {
		if (totalUsed + cost <= this._limit) {
			return now;
		}

		const targetToFree = totalUsed + cost - this._limit;
		let freed = 0;
		let availableAt = now;

		for (const entry of logs) {
			freed += entry.count;

			if (freed >= targetToFree) {
				availableAt = entry.ts + this._windowMs;
				break;
			}
		}

		return Math.max(now, availableAt);
	}
}
