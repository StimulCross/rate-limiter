import { Deque } from '@stimulcross/ds-deque';
import { describe, it, expect } from 'vitest';
import { InvalidCostError } from '../../../src/index.js';
import {
	type SlidingWindowLogEntry,
	type SlidingWindowLogState,
} from '../../../src/limiters/sliding-window-log/index.js';
import { SlidingWindowLogPolicy } from '../../../src/limiters/sliding-window-log/sliding-window-log.policy.js';

function buildState(entries: SlidingWindowLogEntry[]): SlidingWindowLogState {
	const logs = new Deque<SlidingWindowLogEntry>();
	let totalUsed = 0;

	for (const entry of entries) {
		logs.push({ ...entry });
		totalUsed += entry.count;
	}

	return { logs, totalUsed };
}

describe('SlidingWindowLogPolicy', () => {
	describe('Constructor and getters', () => {
		it('should initialize with valid parameters', () => {
			const policy = new SlidingWindowLogPolicy(10, 1000);
			expect(policy.limit).toBe(10);
			expect(policy.windowMs).toBe(1000);
		});

		it('should throw an error for invalid limit', () => {
			expect(() => new SlidingWindowLogPolicy(0, 1000)).toThrow(/Invalid limit/u);
			expect(() => new SlidingWindowLogPolicy(-5, 1000)).toThrow(/Invalid limit/u);
			expect(() => new SlidingWindowLogPolicy(1.5, 1000)).toThrow(/Invalid limit/u);
			expect(() => new SlidingWindowLogPolicy(Infinity, 1000)).toThrow(/Invalid limit/u);
		});

		it('should throw an error for invalid windowMs', () => {
			expect(() => new SlidingWindowLogPolicy(10, 0)).toThrow(/Invalid windowMs/u);
			expect(() => new SlidingWindowLogPolicy(10, -100)).toThrow(/Invalid windowMs/u);
			expect(() => new SlidingWindowLogPolicy(10, 100.5)).toThrow(/Invalid windowMs/u);
			expect(() => new SlidingWindowLogPolicy(10, Number.NaN)).toThrow(/Invalid windowMs/u);
		});

		it('should return correct initial state', () => {
			const policy = new SlidingWindowLogPolicy(5, 1000);
			const state = policy.getInitialState();

			expect(state.totalUsed).toBe(0);
			expect(state.logs).toBeInstanceOf(Deque);
			expect(state.logs.isEmpty).toBe(true);
		});
	});

	describe('Get Status', () => {
		const policy = new SlidingWindowLogPolicy(5, 1000);

		it('should return correct status for empty state', () => {
			const state = policy.getInitialState();
			const status = policy.getStatus(state, 500);

			expect(status.limit).toBe(5);
			expect(status.windowMs).toBe(1000);
			expect(status.totalUsed).toBe(0);
			expect(status.remaining).toBe(5);
			expect(status.nextAvailableAt).toBe(500);
			expect(status.resetAt).toBe(500);
		});

		it('should clear expired logs during getStatus and return accurate remaining capacity', () => {
			const state = buildState([
				{ ts: 100, count: 2 },
				{ ts: 500, count: 1 },
			]);
			const status = policy.getStatus(state, 1200);

			expect(status.totalUsed).toBe(1);
			expect(status.remaining).toBe(4);
			expect(status.resetAt).toBe(1500);
		});

		it('should calculate precise nextAvailableAt when queue is full', () => {
			const state = buildState([
				{ ts: 100, count: 2 },
				{ ts: 500, count: 3 },
			]);

			const status = policy.getStatus(state, 600);

			expect(status.remaining).toBe(0);
			expect(status.nextAvailableAt).toBe(1100);
			expect(status.resetAt).toBe(1500);
		});
	});

	describe('Evaluate', () => {
		describe('Validation and Edge Cases', () => {
			const policy = new SlidingWindowLogPolicy(5, 1000);

			it('should throw if cost itself exceeds limit', () => {
				const state = policy.getInitialState();
				expect(() => policy.evaluate(state, 500, 6)).toThrow(InvalidCostError);
			});
		});

		describe('Immediate execution', () => {
			const policy = new SlidingWindowLogPolicy(2, 1000);

			it('should allow request when within limit', () => {
				const state = policy.getInitialState();
				const result = policy.evaluate(state, 500, 1);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState.totalUsed).toBe(1);
				expect(result.nextState.logs.size).toBe(1);
				expect(result.nextState.logs.peekTail()).toEqual({ ts: 500, count: 1 });
			});

			it('should allow request with cost > 1 if within limit', () => {
				const state = policy.getInitialState();
				const result = policy.evaluate(state, 500, 2);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState.totalUsed).toBe(2);
				expect(result.nextState.logs.peekTail()?.count).toBe(2);
			});

			it('should deny request and return precise retryAt when limit is exceeded', () => {
				const state = buildState([{ ts: 100, count: 2 }]);
				const result = policy.evaluate(state, 500, 1);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1100 });
				expect(result.nextState.totalUsed).toBe(2);
			});
		});

		describe('Log grouping and aggregation', () => {
			const policy = new SlidingWindowLogPolicy(5, 1000);

			it('should mutate existing log entry if timestamp exactly matches now', () => {
				const state = buildState([{ ts: 500, count: 1 }]);
				const result = policy.evaluate(state, 500, 2);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.logs.size).toBe(1);
				expect(result.nextState.logs.peekTail()).toEqual({ ts: 500, count: 3 });
				expect(result.nextState.totalUsed).toBe(3);
			});

			it('should append a new log entry if timestamp differs', () => {
				const state = buildState([{ ts: 500, count: 1 }]);
				const result = policy.evaluate(state, 501, 2);

				expect(result.nextState.logs.size).toBe(2);
				expect(result.nextState.logs.peekTail()).toEqual({ ts: 501, count: 2 });
				expect(result.nextState.totalUsed).toBe(3);
			});
		});

		describe('Eviction and Exact retryAt Calculation', () => {
			const policy = new SlidingWindowLogPolicy(5, 1000);

			it('should evict expired logs from the front of the queue', () => {
				const state = buildState([
					{ ts: 100, count: 2 },
					{ ts: 500, count: 1 },
				]);

				const result = policy.evaluate(state, 1200, 1);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.logs.size).toBe(2);
				expect(result.nextState.logs.peekHead()).toEqual({ ts: 500, count: 1 });
				expect(result.nextState.totalUsed).toBe(2);
			});

			it('should evaluate retryAt correctly by summing multiple logs if necessary', () => {
				const state = buildState([
					{ ts: 100, count: 1 },
					{ ts: 200, count: 2 },
					{ ts: 500, count: 2 },
				]);

				const result = policy.evaluate(state, 600, 3);
				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1200 });
			});
		});
	});

	describe('Revert', () => {
		const policy = new SlidingWindowLogPolicy(10, 1000);

		describe('Within the same window', () => {
			it('should return unmodified state if cost is zero or negative', () => {
				const state = buildState([{ ts: 500, count: 3 }]);
				const nextState = policy.revert(state, 0, 1000);

				expect(nextState.totalUsed).toBe(3);
				expect(nextState.logs.size).toBe(1);
			});

			it('should return unmodified state if totalUsed is zero', () => {
				const state = policy.getInitialState();
				const nextState = policy.revert(state, 5, 1000);

				expect(nextState.totalUsed).toBe(0);
				expect(nextState.logs.isEmpty).toBe(true);
			});

			it('should revert exact cost by decrementing the tail log count', () => {
				const state = buildState([
					{ ts: 100, count: 2 },
					{ ts: 200, count: 3 },
				]);

				const nextState = policy.revert(state, 2, 1000);

				expect(nextState.totalUsed).toBe(3);
				expect(nextState.logs.size).toBe(2);
				expect(nextState.logs.peekTail()).toEqual({ ts: 200, count: 1 });
			});

			it('should remove the tail log entirely if revert cost equals its count', () => {
				const state = buildState([
					{ ts: 100, count: 2 },
					{ ts: 200, count: 3 },
				]);

				const nextState = policy.revert(state, 3, 1000);

				expect(nextState.totalUsed).toBe(2);
				expect(nextState.logs.size).toBe(1);
				expect(nextState.logs.peekTail()).toEqual({ ts: 100, count: 2 });
			});

			it('should remove multiple newer entries if cost spans across them', () => {
				const state = buildState([
					{ ts: 100, count: 2 },
					{ ts: 200, count: 3 },
					{ ts: 300, count: 1 },
				]);

				const nextState = policy.revert(state, 5, 1000);

				expect(nextState.totalUsed).toBe(1);
				expect(nextState.logs.size).toBe(1);
				expect(nextState.logs.peekHead()).toEqual({ ts: 100, count: 1 });
			});

			it('should not drop totalUsed below zero when reverting excessively large costs', () => {
				const state = buildState([{ ts: 100, count: 2 }]);
				const nextState = policy.revert(state, 10, 1000);

				expect(nextState.totalUsed).toBe(0);
				expect(nextState.logs.isEmpty).toBe(true);
			});
		});

		describe('With time sync (window transitions)', () => {
			it('should sync time and remove expired logs before reverting', () => {
				const state = buildState([
					{ ts: 100, count: 2 },
					{ ts: 500, count: 3 },
				]);

				const nextState = policy.revert(state, 1, 1200);

				expect(nextState.totalUsed).toBe(2);
				expect(nextState.logs.size).toBe(1);
				expect(nextState.logs.peekHead()).toEqual({ ts: 500, count: 2 });
			});

			it('should handle revert safely if all logs expired before revert', () => {
				const state = buildState([
					{ ts: 100, count: 2 },
					{ ts: 200, count: 3 },
				]);

				const nextState = policy.revert(state, 2, 1500);

				expect(nextState.totalUsed).toBe(0);
				expect(nextState.logs.isEmpty).toBe(true);
			});
		});
	});
});
