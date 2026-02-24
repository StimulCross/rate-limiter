import { type Decision } from './decision.js';

/** @internal */
export interface RateLimitPolicyResult<S> {
	decision: Decision;
	nextState: S;
}

/** @internal */
export interface RateLimitPolicy<TState extends object = object, TStatus extends object = object> {
	getInitialState(now: number): TState;
	getStatus(state: TState, now: number): TStatus;
	evaluate(state: TState, now: number, cost: number, shouldReserve?: boolean): RateLimitPolicyResult<TState>;
	revert(state: TState, cost: number, now: number): TState;
}
