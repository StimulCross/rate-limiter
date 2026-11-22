import type { createLimiterLogger } from '../utils/limiter-logging.js'
import type { RateLimitPolicy } from './rate-limit-policy.js'
import type { TaskOutcome } from './task-outcome.js'

/** @internal */
export const WAIT_FOR_SETTLEMENT = Symbol('wait for settlement')

/** @internal */
export type QuotaBlock = number | typeof WAIT_FOR_SETTLEMENT | undefined

/** @internal */
export interface SettlementContext {
	readonly id?: string
	readonly key: string
	readonly isCurrent: () => boolean
	readonly readTime: () => number
	readonly log: ReturnType<typeof createLimiterLogger>
}

/** @internal */
export type SettleTask<TResult> = (outcome: TaskOutcome<TResult>) => void

/** @internal */
export interface CoordinatorPolicy<TState, TStatus, TResult = unknown> extends Omit<RateLimitPolicy<TState, TStatus>, 'check'> {
	/**
	 * Initializes persistent history for a touched key, if needed.
	 */
	createState?: () => TState

	/**
	 * Observes readiness at the supplied effective time, including a possible wait for settlement.
	 */
	check: (state: TState | undefined, time: number) => QuotaBlock

	/**
	 * Captures any start-specific state needed when the callback settles.
	 */
	trackSettlement?: (state: TState, context: SettlementContext) => SettleTask<TResult>
}
