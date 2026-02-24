import { describe, it, expect } from 'vitest';
import { InvalidCostError } from '../../../src/index.js';
import { TokenBucketPolicy } from '../../../src/limiters/token-bucket/token-bucket.policy.js';

describe('TokenBucketPolicy', () => {
	describe('Constructor', () => {
		it('should initialize with valid parameters', () => {
			const policy = new TokenBucketPolicy(10, 5, 20);
			expect(policy.capacity).toBe(10);
			expect(policy.refillRate).toBe(5);
		});

		it('should throw an error for invalid capacity', () => {
			expect(() => new TokenBucketPolicy(0, 5)).toThrow(/Invalid capacity/u);
			expect(() => new TokenBucketPolicy(-10, 5)).toThrow(/Invalid capacity/u);
			expect(() => new TokenBucketPolicy(5.5, 5)).toThrow(/Invalid capacity/u);
		});

		it('should throw an error for invalid refillRate', () => {
			expect(() => new TokenBucketPolicy(10, 0)).toThrow(/Invalid refillRate/u);
			expect(() => new TokenBucketPolicy(10, -5)).toThrow(/Invalid refillRate/u);
			expect(() => new TokenBucketPolicy(10, Number.NaN)).toThrow(/Invalid refillRate/u);
		});

		it('should throw an error for invalid maxDebt', () => {
			expect(() => new TokenBucketPolicy(10, 5, -5)).toThrow(/Invalid maxDebt/u);
			expect(() => new TokenBucketPolicy(10, 5, 5.5)).toThrow(/Invalid maxDebt/u);
		});

		it('should return correct initial state', () => {
			const policy = new TokenBucketPolicy(10, 5);
			expect(policy.getInitialState()).toEqual({ tokens: 10, debt: 0, lastRefill: 0 });
		});

		it('should allow Infinity as maxDebt', () => {
			expect(() => new TokenBucketPolicy(10, 5, Number.POSITIVE_INFINITY)).not.toThrow();
		});
	});

	describe('Get Status', () => {
		const policy = new TokenBucketPolicy(10, 10);

		it('should return correct info for completely full bucket', () => {
			const state = policy.getInitialState();
			const status = policy.getStatus(state, 1000);

			expect(status.capacity).toBe(10);
			expect(status.refillRate).toBe(10);
			expect(status.tokens).toBe(10);
			expect(status.debt).toBe(0);
			expect(status.nextAvailableAt).toBe(1000);
			expect(status.resetAt).toBe(1000);
		});

		it('should return correct info for partially depleted bucket', () => {
			const state = { tokens: 5, debt: 0, lastRefill: 1000 };
			const status = policy.getStatus(state, 1000);

			expect(status.tokens).toBe(5);
			expect(status.debt).toBe(0);
			expect(status.nextAvailableAt).toBe(1000);
			expect(status.resetAt).toBe(1500);
		});

		it('should return correct info for bucket with active debt', () => {
			const state = { tokens: 0, debt: 5, lastRefill: 1000 };
			const status = policy.getStatus(state, 1000);

			expect(status.tokens).toBe(0);
			expect(status.debt).toBe(5);
			expect(status.nextAvailableAt).toBe(1600);
			expect(status.resetAt).toBe(2500);
		});

		it('should calculate nextAvailableAt and resetAt correctly with fractional refillRate', () => {
			const fractionalPolicy = new TokenBucketPolicy(10, 2.5);
			const state = { tokens: 0, debt: 0, lastRefill: 1000 };
			const status = fractionalPolicy.getStatus(state, 1000);

			expect(status.nextAvailableAt).toBe(1400);
			expect(status.resetAt).toBe(5000);
		});
	});

	describe('Evaluate', () => {
		describe('Validation and Edge Cases', () => {
			const policy = new TokenBucketPolicy(10, 5);

			it('should throw if cost exceeds the bucket capacity', () => {
				const state = policy.getInitialState();
				expect(() => policy.evaluate(state, 1000, 15)).toThrow(InvalidCostError);
			});

			it('should allow zero cost without consuming tokens', () => {
				const state = { tokens: 5, debt: 0, lastRefill: 1000 };
				const result = policy.evaluate(state, 1000, 0);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.tokens).toBe(5);
			});

			it('should handle time jumping backwards gracefully', () => {
				const state = { tokens: 5, debt: 0, lastRefill: 2000 };
				const result = policy.evaluate(state, 1000, 1);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.tokens).toBe(4);
				expect(result.nextState.lastRefill).toBe(2000);
			});
		});

		describe('Immediate execution', () => {
			const policy = new TokenBucketPolicy(10, 10);

			it('should allow request when tokens are sufficient', () => {
				const state = policy.getInitialState();
				const result = policy.evaluate(state, 1000, 3);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState).toEqual({ tokens: 7, debt: 0, lastRefill: 1000 });
			});

			it('should deny request and return correct retryAt when tokens are insufficient', () => {
				const state = { tokens: 2, debt: 0, lastRefill: 1000 };
				const result = policy.evaluate(state, 1000, 5);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1300 });
				expect(result.nextState).toEqual(state);
			});

			it('should not mutate synced state on deny after time sync', () => {
				const state = { tokens: 1, debt: 2, lastRefill: 1000 };
				const result = policy.evaluate(state, 1100, 5);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1600 });
				expect(result.nextState).toEqual({ tokens: 1, debt: 1, lastRefill: 1100 });
			});
		});

		describe('Reservation and Delay', () => {
			const policy = new TokenBucketPolicy(10, 10, 20);

			it('should delay request when tokens are insufficient and reservation is enabled', () => {
				const state = { tokens: 2, debt: 0, lastRefill: 1000 };
				const result = policy.evaluate(state, 1000, 5, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 1300 });
				expect(result.nextState).toEqual({ tokens: 0, debt: 3, lastRefill: 1000 });
			});

			it('should accumulate debt across multiple reservations', () => {
				const state = { tokens: 0, debt: 3, lastRefill: 1000 };
				const result = policy.evaluate(state, 1000, 5, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 1800 });
				expect(result.nextState).toEqual({ tokens: 0, debt: 8, lastRefill: 1000 });
			});

			it('should deny reservation if maxDebt is exceeded', () => {
				const state = { tokens: 0, debt: 15, lastRefill: 1000 };
				const result = policy.evaluate(state, 1000, 10, true);

				expect(result.decision.kind).toBe('deny');
				expect(result.nextState).toEqual(state);
			});

			it('should accurately calculate retryAt when maxDebt is exceeded (debt clearance logic)', () => {
				const state = { tokens: 0, debt: 15, lastRefill: 1000 };
				const result = policy.evaluate(state, 1000, 10, true);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1500 });
			});

			it('should allow unlimited reservation growth when maxDebt is Infinity', () => {
				const infiniteDebtPolicy = new TokenBucketPolicy(10, 10, Number.POSITIVE_INFINITY);
				const state = { tokens: 0, debt: 50, lastRefill: 1000 };
				const result = infiniteDebtPolicy.evaluate(state, 1000, 10, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 7000 });
				expect(result.nextState).toEqual({ tokens: 0, debt: 60, lastRefill: 1000 });
			});
		});

		describe('Refill and State Sync', () => {
			const policy = new TokenBucketPolicy(10, 10);

			it('should refill tokens accurately based on elapsed time', () => {
				const state = { tokens: 2, debt: 0, lastRefill: 1000 };
				const result = policy.evaluate(state, 1500, 1);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ tokens: 6, debt: 0, lastRefill: 1500 });
			});

			it('should cap refilled tokens at the maximum capacity', () => {
				const state = { tokens: 5, debt: 0, lastRefill: 1000 };
				const result = policy.evaluate(state, 5000, 1);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ tokens: 9, debt: 0, lastRefill: 5000 });
			});

			it('should pay off debt before accumulating tokens', () => {
				const state = { tokens: 0, debt: 5, lastRefill: 1000 };
				const result = policy.evaluate(state, 1800, 1);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ tokens: 2, debt: 0, lastRefill: 1800 });
			});

			it('should partially pay off debt if elapsed time is short', () => {
				const state = { tokens: 0, debt: 10, lastRefill: 1000 };
				const result = policy.evaluate(state, 1400, 2, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 2200 });
				expect(result.nextState).toEqual({ tokens: 0, debt: 8, lastRefill: 1400 });
			});

			it('should handle fractional refillRate precisely for allow path', () => {
				const fractionalPolicy = new TokenBucketPolicy(10, 2.5);
				const state = { tokens: 1, debt: 0, lastRefill: 1000 };
				const result = fractionalPolicy.evaluate(state, 1400, 1);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState).toEqual({ tokens: 1, debt: 0, lastRefill: 1400 });
			});

			it('should round up retryAt with fractional refillRate', () => {
				const fractionalPolicy = new TokenBucketPolicy(10, 2.5);
				const state = { tokens: 0, debt: 0, lastRefill: 1000 };
				const result = fractionalPolicy.evaluate(state, 1000, 1);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1400 });
				expect(result.nextState).toEqual(state);
			});

			it('should round up runAt with fractional refillRate when reserving', () => {
				const fractionalPolicy = new TokenBucketPolicy(10, 2.5);
				const state = { tokens: 0, debt: 0, lastRefill: 1000 };
				const result = fractionalPolicy.evaluate(state, 1000, 1, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 1400 });
				expect(result.nextState).toEqual({ tokens: 0, debt: 1, lastRefill: 1000 });
			});
		});
	});

	describe('Revert', () => {
		const policy = new TokenBucketPolicy(10, 10);

		it('should add reverted cost back to tokens when there is no debt', () => {
			const state = { tokens: 5, debt: 0, lastRefill: 1000 };
			const result = policy.revert(state, 3, 1500);

			expect(result).toEqual({ tokens: 10, debt: 0, lastRefill: 1500 });
		});

		it('should not exceed capacity when reverting tokens', () => {
			const state = { tokens: 8, debt: 0, lastRefill: 1000 };
			const result = policy.revert(state, 5, 1000);

			expect(result).toEqual({ tokens: 10, debt: 0, lastRefill: 1000 });
		});

		it('should return exact cost to tokens when capacity allows', () => {
			const state = { tokens: 3, debt: 0, lastRefill: 1000 };
			const result = policy.revert(state, 3, 1000);

			expect(result).toEqual({ tokens: 6, debt: 0, lastRefill: 1000 });
		});

		it('should decrease debt when cost <= debt (no spill to tokens)', () => {
			const state = { tokens: 0, debt: 5, lastRefill: 1000 };
			const result = policy.revert(state, 3, 1000);

			expect(result).toEqual({ tokens: 0, debt: 2, lastRefill: 1000 });
		});

		it('should zero out debt and spill remainder to tokens', () => {
			const state = { tokens: 0, debt: 2, lastRefill: 1000 };
			const result = policy.revert(state, 5, 1000);

			expect(result).toEqual({ tokens: 3, debt: 0, lastRefill: 1000 });
		});

		it('should zero out debt exactly when cost === debt', () => {
			const state = { tokens: 0, debt: 4, lastRefill: 1000 };
			const result = policy.revert(state, 4, 1000);

			expect(result).toEqual({ tokens: 0, debt: 0, lastRefill: 1000 });
		});

		it('should sync state before reverting: elapsed time reduces debt first', () => {
			const state = { tokens: 0, debt: 8, lastRefill: 1000 };
			const result = policy.revert(state, 2, 1500);

			expect(result).toEqual({ tokens: 0, debt: 1, lastRefill: 1500 });
		});

		it('should sync state before reverting: elapsed time clears debt and fills tokens', () => {
			const state = { tokens: 0, debt: 3, lastRefill: 1000 };
			const result = policy.revert(state, 1, 1500);

			expect(result).toEqual({ tokens: 3, debt: 0, lastRefill: 1500 });
		});

		it('should update lastRefill to now after sync', () => {
			const state = { tokens: 0, debt: 5, lastRefill: 1000 };
			const result = policy.revert(state, 1, 2000);

			expect(result.lastRefill).toBe(2000);
		});

		it('should handle cost=1 (minimum) correctly', () => {
			const state = { tokens: 0, debt: 1, lastRefill: 1000 };
			const result = policy.revert(state, 1, 1000);

			expect(result).toEqual({ tokens: 0, debt: 0, lastRefill: 1000 });
		});

		it('should handle revert when tokens are already at capacity (no debt)', () => {
			const state = { tokens: 10, debt: 0, lastRefill: 1000 };
			const result = policy.revert(state, 5, 1000);

			expect(result).toEqual({ tokens: 10, debt: 0, lastRefill: 1000 });
		});

		it('should handle revert with lastRefill=0 (initial state)', () => {
			const state = { tokens: 0, debt: 0, lastRefill: 0 };
			const result = policy.revert(state, 3, 5000);

			expect(result).toEqual({ tokens: 10, debt: 0, lastRefill: 5000 });
		});

		it('should handle revert when now === lastRefill (no time elapsed)', () => {
			const state = { tokens: 4, debt: 3, lastRefill: 2000 };
			const result = policy.revert(state, 2, 2000);

			expect(result).toEqual({ tokens: 4, debt: 1, lastRefill: 2000 });
		});

		it('should handle revert when elapsed time fully covers debt and fills tokens to capacity', () => {
			const state = { tokens: 0, debt: 3, lastRefill: 1000 };
			const result = policy.revert(state, 5, 3000);

			expect(result).toEqual({ tokens: 10, debt: 0, lastRefill: 3000 });
		});

		it('should handle full capacity revert on spill with partial debt', () => {
			const state = { tokens: 7, debt: 2, lastRefill: 1000 };
			const result = policy.revert(state, 5, 1000);

			expect(result).toEqual({ tokens: 10, debt: 0, lastRefill: 1000 });
		});

		it('should never produce negative debt after revert', () => {
			const state = { tokens: 0, debt: 2, lastRefill: 1000 };
			const result = policy.revert(state, 10, 1000);

			expect(result.debt).toBe(0);
		});

		it('should never exceed capacity after revert even with large spill', () => {
			const state = { tokens: 9, debt: 1, lastRefill: 1000 };
			const result = policy.revert(state, 10, 1000);

			expect(result.tokens).toBe(10);
			expect(result.debt).toBe(0);
		});
	});
});
