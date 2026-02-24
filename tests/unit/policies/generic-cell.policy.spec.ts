import { describe, expect, it } from 'vitest';
import { InvalidCostError } from '../../../src/index.js';
import { GenericCellPolicy } from '../../../src/limiters/generic-cell/generic-cell.policy.js';

describe('GenericCellPolicy', () => {
	describe('Constructor', () => {
		it('should initialize with valid parameters', () => {
			const policy = new GenericCellPolicy(100, 5, 200);
			expect(policy.intervalMs).toBe(100);
			expect(policy.burst).toBe(5);
		});

		it('should throw an error for invalid intervalMs', () => {
			expect(() => new GenericCellPolicy(0, 5)).toThrow(/Invalid intervalMs/u);
			expect(() => new GenericCellPolicy(-10, 5)).toThrow(/Invalid intervalMs/u);
			expect(() => new GenericCellPolicy(10.5, 5)).toThrow(/Invalid intervalMs/u);
		});

		it('should throw an error for invalid burst', () => {
			expect(() => new GenericCellPolicy(100, 0)).toThrow(/Invalid burst/u);
			expect(() => new GenericCellPolicy(100, -2)).toThrow(/Invalid burst/u);
			expect(() => new GenericCellPolicy(100, 1.5)).toThrow(/Invalid burst/u);
		});

		it('should throw an error for invalid maxDelayMs', () => {
			expect(() => new GenericCellPolicy(100, 5, -50)).toThrow(/Invalid maxDelayMs/u);
			expect(() => new GenericCellPolicy(100, 5, 5.5)).toThrow(/Invalid maxDelayMs/u);
		});

		it('should return correct initial state', () => {
			const policy = new GenericCellPolicy(100, 5);
			expect(policy.getInitialState()).toEqual({ tat: 0 });
		});
	});

	describe('Get Status', () => {
		const policy = new GenericCellPolicy(100, 5);

		it('should return correct info for completely idle system', () => {
			const state = policy.getInitialState();
			const status = policy.getStatus(state, 1000);

			expect(status.intervalMs).toBe(100);
			expect(status.burst).toBe(5);
			expect(status.tat).toBe(1000);
			expect(status.remaining).toBe(5);
			expect(status.nextAvailableAt).toBe(1000);
			expect(status.resetAt).toBe(1000);
		});

		it('should return correct info for partially utilized burst', () => {
			const state = { tat: 1200 };
			const status = policy.getStatus(state, 1000);

			expect(status.tat).toBe(1200);
			expect(status.remaining).toBe(3);
			expect(status.nextAvailableAt).toBe(1000);
			expect(status.resetAt).toBe(1200);
		});

		it('should return correct info for fully utilized and delayed system (queueing)', () => {
			const state = { tat: 1700 };
			const status = policy.getStatus(state, 1000);

			expect(status.tat).toBe(1700);
			expect(status.remaining).toBe(0);

			expect(status.nextAvailableAt).toBe(1300);
			expect(status.resetAt).toBe(1700);
		});
	});

	describe('Evaluate', () => {
		describe('Validation and Edge Cases', () => {
			const policy = new GenericCellPolicy(100, 5, 300);

			it('should throw if cost exceeds burst without reservation', () => {
				const state = policy.getInitialState();
				expect(() => policy.evaluate(state, 1000, 6, false)).toThrow(InvalidCostError);
			});

			it('should throw if cost exceeds total capacity (burst + max queue) with reservation', () => {
				const state = policy.getInitialState();
				expect(() => policy.evaluate(state, 1000, 9, true)).toThrow(InvalidCostError);
			});

			it('should allow zero cost without increasing TAT (status check)', () => {
				const state = { tat: 1200 };
				const result = policy.evaluate(state, 1000, 0);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.tat).toBe(1200);
			});
		});

		describe('Immediate execution (Burst allowance)', () => {
			const policy = new GenericCellPolicy(100, 5);

			it('should allow request when TAT is in the past (idle system)', () => {
				const state = { tat: 500 };
				const result = policy.evaluate(state, 1000, 1);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState).toEqual({ tat: 1100 });
			});

			it('should allow request when TAT is in the future but within burst offset', () => {
				const state = { tat: 1400 };
				const result = policy.evaluate(state, 1000, 1);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState).toEqual({ tat: 1500 });
			});

			it('should deny request without reservation when TAT exceeds burst offset', () => {
				const state = { tat: 1600 };
				const result = policy.evaluate(state, 1000, 1);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1200 });
				expect(result.nextState).toEqual({ tat: 1600 });
			});

			it('should correctly consume time proportional to the request cost', () => {
				const state = { tat: 1000 };
				const result = policy.evaluate(state, 1000, 3);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ tat: 1300 });
			});
		});

		describe('Reservation and Delay (Queueing)', () => {
			const policy = new GenericCellPolicy(100, 5, 300);

			it('should delay request when limit exceeded but within max delay', () => {
				const state = { tat: 1600 };
				const result = policy.evaluate(state, 1000, 1, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 1200 });
				expect(result.nextState).toEqual({ tat: 1700 });
			});

			it('should stack multiple delayed requests sequentially', () => {
				const state = { tat: 1700 };
				const result = policy.evaluate(state, 1000, 1, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 1300 });
				expect(result.nextState).toEqual({ tat: 1800 });
			});

			it('should accurately calculate retryAt when reservation exceeds max delay', () => {
				const state = { tat: 1900 };
				const result = policy.evaluate(state, 1000, 1, true);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1200 });
				expect(result.nextState).toEqual({ tat: 1900 });
			});
		});
	});

	describe('Revert', () => {
		const policy = new GenericCellPolicy(100, 5);

		it('should decrease TAT by the cost interval', () => {
			const state = { tat: 1500 };
			const nextState = policy.revert(state, 2);

			expect(nextState).toEqual({ tat: 1300 });
		});

		it('should not drop TAT below zero', () => {
			const state = { tat: 150 };
			const nextState = policy.revert(state, 2);

			expect(nextState).toEqual({ tat: 0 });
		});
	});
});
