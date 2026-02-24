import { type DecisionKind } from '../core/decision.js';
import { type RateLimitPolicy, type RateLimitPolicyResult } from '../core/rate-limit-policy.js';
import { validateCost } from '../utils/validate-cost.js';

type CompositeState<T> = T[];
type CompositeInfo<T> = T[];

/** @internal */
export class CompositePolicy<
	S extends object = object,
	I extends object = object,
	P extends RateLimitPolicy<S, I> = RateLimitPolicy<S, I>,
> implements RateLimitPolicy<CompositeState<S>, CompositeInfo<I>> {
	constructor(private readonly _policies: P[]) {}

	public get policies(): P[] {
		return this._policies;
	}

	public getInitialState(now: number): CompositeState<S> {
		return this._policies.map(policy => policy.getInitialState(now));
	}

	public getStatus(states: CompositeState<S>, now: number): CompositeInfo<I> {
		const result: CompositeInfo<I> = [];

		for (let i = 0; i < this._policies.length; i++) {
			const policy = this._policies[i];
			const state = states[i];
			const info = policy.getStatus(state, now);

			result.push(info);
		}

		return result;
	}

	public evaluate(
		states: CompositeState<S>,
		now: number,
		cost?: number,
		shouldReserve?: boolean,
	): RateLimitPolicyResult<CompositeState<S>> {
		if (cost === undefined) {
			cost = 1;
		} else {
			validateCost(cost);
		}

		const results: Array<RateLimitPolicyResult<S>> = [];

		let compositeDecision: DecisionKind = 'allow';
		let maxRetryAt = 0;
		let maxRunAt = 0;

		for (let i = 0; i < this._policies.length; i++) {
			const policy = this._policies[i];
			const state = states[i];

			const result = policy.evaluate(state, now, cost, shouldReserve);
			results.push(result);

			if (result.decision.kind === 'deny') {
				compositeDecision = 'deny';
				maxRetryAt = Math.max(maxRetryAt, result.decision.retryAt);
			} else if (result.decision.kind === 'delay') {
				if (compositeDecision !== 'deny') {
					compositeDecision = 'delay';
				}

				maxRunAt = Math.max(maxRunAt, result.decision.runAt);
			}
		}

		if (compositeDecision === 'deny') {
			const nextState = results.map((res, i) =>
				res.decision.kind === 'deny' ? res.nextState : this._policies[i].revert(res.nextState, cost, now),
			);

			return {
				decision: { kind: 'deny', retryAt: maxRetryAt },
				nextState,
			};
		}

		if (compositeDecision === 'delay') {
			return {
				decision: { kind: 'delay', runAt: maxRunAt },
				nextState: results.map(res => res.nextState),
			};
		}

		return {
			decision: { kind: 'allow' },
			nextState: results.map(res => res.nextState),
		};
	}

	public revert(states: S[], cost: number, now: number): S[] {
		return states.map((state, i) => this._policies[i].revert(state, cost, now));
	}
}
