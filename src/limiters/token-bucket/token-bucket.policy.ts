import { type TokenBucketState } from './token-bucket.state.js';
import { type TokenBucketStatus } from './token-bucket.status.js';
import { type RateLimitPolicy, type RateLimitPolicyResult } from '../../core/rate-limit-policy.js';
import { validateCost } from '../../utils/validate-cost.js';

/** @internal */
export class TokenBucketPolicy implements RateLimitPolicy<TokenBucketState, TokenBucketStatus> {
	constructor(
		private readonly _capacity: number,
		private readonly _refillRate: number,
		private readonly _maxDebt: number = Number.POSITIVE_INFINITY,
	) {
		if (!Number.isSafeInteger(_capacity) || _capacity <= 0) {
			throw new Error(`Invalid capacity: ${_capacity}. Must be a positive integer.`);
		}

		if (!Number.isFinite(_refillRate) || _refillRate <= 0) {
			throw new Error(`Invalid refillRate: ${_refillRate}. Must be a positive number.`);
		}

		if (_maxDebt < 0 || (!Number.isSafeInteger(_maxDebt) && _maxDebt !== Number.POSITIVE_INFINITY)) {
			throw new Error(`Invalid maxDebt: ${_maxDebt}. Must be a non-negative integer or Infinity.`);
		}
	}

	public get capacity(): number {
		return this._capacity;
	}

	public get refillRate(): number {
		return this._refillRate;
	}

	public getInitialState(): TokenBucketState {
		return { tokens: this._capacity, debt: 0, lastRefill: 0 };
	}

	public getStatus(state: TokenBucketState, now: number): TokenBucketStatus {
		const { tokens, debt } = this._syncState(state, now);

		const deficitToOne = Math.max(0, debt + 1 - tokens);
		const nextAvailableAt = deficitToOne === 0 ? now : now + Math.ceil((deficitToOne / this._refillRate) * 1000);

		const deficitToCapacity = debt + (this._capacity - tokens);
		const resetAt = deficitToCapacity === 0 ? now : now + Math.ceil((deficitToCapacity / this._refillRate) * 1000);

		return {
			capacity: this._capacity,
			refillRate: this._refillRate,
			tokens,
			debt,
			nextAvailableAt,
			resetAt,
		};
	}

	public evaluate(
		state: TokenBucketState,
		now: number,
		cost: number,
		shouldReserve?: boolean,
	): RateLimitPolicyResult<TokenBucketState> {
		validateCost(cost, this._capacity);

		const { tokens, debt, lastRefill } = this._syncState(state, now);

		if (tokens >= cost) {
			return {
				decision: { kind: 'allow' },
				nextState: { tokens: tokens - cost, debt, lastRefill },
			};
		}

		const deficit = cost - tokens;

		if (shouldReserve) {
			const newDebt = debt + deficit;

			if (newDebt > this._maxDebt) {
				const targetDebt = this._maxDebt - deficit;
				const debtToClear = Math.max(0, debt - targetDebt);
				const waitMs = Math.ceil((debtToClear / this._refillRate) * 1000);
				const retryAt = now + waitMs;

				return this._deny(tokens, debt, lastRefill, retryAt);
			}

			const waitMs = Math.ceil((newDebt / this._refillRate) * 1000);
			const runAt = now + waitMs;

			return {
				decision: { kind: 'delay', runAt },
				nextState: { tokens: 0, debt: newDebt, lastRefill },
			};
		}

		const totalNeeded = debt + deficit;
		const waitMs = Math.ceil((totalNeeded / this._refillRate) * 1000);
		const retryAt = now + waitMs;

		return this._deny(tokens, debt, lastRefill, retryAt);
	}

	public revert(state: TokenBucketState, cost: number, now: number): TokenBucketState {
		let { tokens, debt, lastRefill } = this._syncState(state, now);

		if (debt >= cost) {
			debt -= cost;
		} else {
			const remainder = cost - debt;
			debt = 0;
			tokens = Math.min(this._capacity, tokens + remainder);
		}

		return { tokens, debt, lastRefill };
	}

	private _deny(
		tokens: number,
		debt: number,
		lastRefill: number,
		retryAt: number,
	): RateLimitPolicyResult<TokenBucketState> {
		return {
			decision: { kind: 'deny', retryAt },
			nextState: { tokens, debt, lastRefill },
		};
	}

	private _syncState(state: TokenBucketState, now: number): TokenBucketState {
		if (state.lastRefill === 0) {
			return { tokens: this._capacity, debt: 0, lastRefill: now };
		}

		if (now <= state.lastRefill) {
			return state;
		}

		let { tokens, debt } = state;

		const elapsedMs = now - state.lastRefill;
		const generatedTokens = (elapsedMs / 1000) * this._refillRate;

		if (debt > 0) {
			const payOff = Math.min(debt, generatedTokens);
			debt -= payOff;
			const remainingTokens = generatedTokens - payOff;
			tokens = Math.min(this._capacity, tokens + remainingTokens);
		} else {
			tokens = Math.min(this._capacity, tokens + generatedTokens);
		}

		return { tokens, debt, lastRefill: now };
	}
}
