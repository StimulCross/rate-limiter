import { describe, it, expect } from 'vitest';
import { InvalidCostError } from '../../../src/index.js';
import { LeakyBucketPolicy } from '../../../src/limiters/leaky-bucket/leaky-bucket.policy.js';

describe('LeakyBucketPolicy', () => {
	describe('Constructor', () => {
		it('should initialize with valid parameters', () => {
			const policy = new LeakyBucketPolicy(100, 10, 50);
			expect(policy.capacity).toBe(100);
			expect(policy.leakRate).toBe(10);
		});

		it('should throw an error for invalid capacity', () => {
			expect(() => new LeakyBucketPolicy(0, 10)).toThrow(/Invalid capacity/u);
			expect(() => new LeakyBucketPolicy(-50, 10)).toThrow(/Invalid capacity/u);
			expect(() => new LeakyBucketPolicy(10.5, 10)).toThrow(/Invalid capacity/u);
		});

		it('should throw an error for invalid leakRate', () => {
			expect(() => new LeakyBucketPolicy(100, 0)).toThrow(/Invalid leakRate/u);
			expect(() => new LeakyBucketPolicy(100, -5)).toThrow(/Invalid leakRate/u);
			expect(() => new LeakyBucketPolicy(100, Number.NaN)).toThrow(/Invalid leakRate/u);
		});

		it('should throw an error for invalid maxOverflow', () => {
			expect(() => new LeakyBucketPolicy(100, 10, -5)).toThrow(/Invalid maxOverflow/u);
			expect(() => new LeakyBucketPolicy(100, 10, 5.5)).toThrow(/Invalid maxOverflow/u);
		});

		it('should return correct initial state', () => {
			const policy = new LeakyBucketPolicy(100, 10);
			expect(policy.getInitialState()).toEqual({ level: 0, lastUpdate: 0 });
		});
	});

	describe('Get Status', () => {
		const policy = new LeakyBucketPolicy(100, 10);

		it('should return correct status for empty bucket', () => {
			const state = policy.getInitialState();
			const status = policy.getStatus(state, 1000);

			expect(status.capacity).toBe(100);
			expect(status.leakRate).toBe(10);
			expect(status.level).toBe(0);
			expect(status.remaining).toBe(100);
			expect(status.nextAvailableAt).toBe(1000);
			expect(status.resetAt).toBe(1000);
		});

		it('should return correct status for partially filled bucket', () => {
			const state = { level: 50, lastUpdate: 1000 };
			const status = policy.getStatus(state, 1000);

			expect(status.level).toBe(50);
			expect(status.remaining).toBe(50);
			expect(status.nextAvailableAt).toBe(1000);
			expect(status.resetAt).toBe(6000);
		});

		it('should return correct status for overflowed bucket', () => {
			const state = { level: 150, lastUpdate: 1000 };
			const status = policy.getStatus(state, 1000);

			expect(status.level).toBe(150);
			expect(status.remaining).toBe(0);

			expect(status.nextAvailableAt).toBe(6100);
			expect(status.resetAt).toBe(16_000);
		});
	});

	describe('Evaluate', () => {
		describe('Validation and Edge Cases', () => {
			const policy = new LeakyBucketPolicy(10, 5);

			it('should throw if cost exceeds the bucket capacity', () => {
				const state = policy.getInitialState();
				expect(() => policy.evaluate(state, 1000, 15)).toThrow(InvalidCostError);
			});

			it('should allow zero cost without increasing level', () => {
				const state = { level: 5, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 0);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.level).toBe(5);
			});

			it('should handle time jumping backwards gracefully', () => {
				const state = { level: 5, lastUpdate: 2000 };
				const result = policy.evaluate(state, 1000, 2);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.level).toBe(7);
				expect(result.nextState.lastUpdate).toBe(2000);
			});
		});

		describe('Immediate execution (Burst allowance)', () => {
			const policy = new LeakyBucketPolicy(10, 5);

			it('should deny request without reservation if capacity is exceeded', () => {
				const state = { level: 8, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 4);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1400 });
				expect(result.nextState).toEqual(state);
			});

			it('should allow request when level exactly reaches capacity', () => {
				const state = { level: 8, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 2);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState.level).toBe(10);
			});

			it('should deny request without reservation if capacity is exceeded', () => {
				const state = { level: 8, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 4);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1400 });
				expect(result.nextState).toEqual(state);
			});
		});

		describe('Leak and State Sync', () => {
			const policy = new LeakyBucketPolicy(20, 10);

			it('should reduce level based on elapsed time before applying cost', () => {
				const state = { level: 15, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1500, 5);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ level: 15, lastUpdate: 1500 });
			});

			it('should not leak below zero', () => {
				const state = { level: 5, lastUpdate: 1000 };
				const result = policy.evaluate(state, 3000, 2);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ level: 2, lastUpdate: 3000 });
			});
		});

		describe('Reservation and Delay', () => {
			const policy = new LeakyBucketPolicy(10, 5, 15);

			it('should delay request when capacity exceeded and reservation is enabled', () => {
				const state = { level: 10, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 4, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 1800 });
				expect(result.nextState).toEqual({ level: 14, lastUpdate: 1000 });
			});

			it('should stack multiple reservations sequentially', () => {
				const state = { level: 14, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 6, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 3000 });
				expect(result.nextState.level).toBe(20);
			});

			it('should deny reservation if overflow exceeds maxOverflow', () => {
				const state = { level: 16, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 10, true);

				expect(result.decision.kind).toBe('deny');
				expect(result.nextState).toEqual(state);
			});

			it('should accurately calculate retryAt when maxOverflow is exceeded', () => {
				const state = { level: 20, lastUpdate: 1000 };
				const result = policy.evaluate(state, 1000, 10, true);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 2000 });
			});
		});
	});

	describe('Revert', () => {
		const policy = new LeakyBucketPolicy(10, 5);

		it('should reduce the level by the requested cost', () => {
			const state = { level: 8, lastUpdate: 1000 };
			const nextState = policy.revert(state, 3, 1000);

			expect(nextState).toEqual({ level: 5, lastUpdate: 1000 });
		});

		it('should not reduce the level below zero', () => {
			const state = { level: 2, lastUpdate: 1000 };
			const nextState = policy.revert(state, 5, 1000);

			expect(nextState).toEqual({ level: 0, lastUpdate: 1000 });
		});

		it('should correctly reduce the level from an overflowed state', () => {
			const state = { level: 15, lastUpdate: 1000 };
			const nextState = policy.revert(state, 10, 1000);

			expect(nextState).toEqual({ level: 5, lastUpdate: 1000 });
		});

		it('should sync time, leak correctly, and then revert', () => {
			const state = { level: 10, lastUpdate: 1000 };
			const nextState = policy.revert(state, 2, 2000);

			expect(nextState).toEqual({ level: 3, lastUpdate: 2000 });
		});
	});
});
