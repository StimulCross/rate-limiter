import type { CoordinatorPolicy, QuotaBlock, SettlementContext } from '../../contracts/coordinator-policy.js'
import type { TaskOutcome } from '../../contracts/task-outcome.js'
import type { HttpFeedback, HttpFeedbackExtractor } from './http-feedback.js'
import type { HttpResponseState } from './http-response-based.state.js'
import type { HttpResponseBasedStatus } from './http-response-based.status.js'
import { LogLevel } from '@stimulcross/logger'
import { WAIT_FOR_SETTLEMENT } from '../../contracts/coordinator-policy.js'
import { addTimestampDelay } from '../../utils/next-timestamp.js'

const DEFAULT_FALLBACK_RESET_DELAY_MS = 60_000

/** @internal */
export class HttpResponsePolicy<TResponse> implements CoordinatorPolicy<HttpResponseState, HttpResponseBasedStatus, TResponse> {
	constructor(
		private readonly _extractFeedback: HttpFeedbackExtractor<TResponse>,
		private readonly _responseFromError?: (error: unknown) => TResponse | null,
		private readonly _fallbackResetDelayMs = DEFAULT_FALLBACK_RESET_DELAY_MS,
	) {
		if (typeof _extractFeedback !== 'function')
			throw new TypeError('HTTP feedback requires a synchronous extractor')

		if (_responseFromError !== undefined && typeof _responseFromError !== 'function')
			throw new TypeError('HTTP response recovery requires a synchronous adapter')

		if (!Number.isFinite(_fallbackResetDelayMs) || _fallbackResetDelayMs <= 0)
			throw new RangeError('Fallback reset delay must be positive and finite')
	}

	public createState(): HttpResponseState {
		return { active: 0, isProbing: false }
	}

	public check(state: HttpResponseState | undefined, time: number): QuotaBlock {
		if (state?.retryAt !== undefined && state.retryAt > time)
			return state.retryAt

		const budget = state?.budget

		if (budget !== undefined && budget.resetAt > time) {
			return budget.remaining === 0
				? budget.resetAt
				: undefined
		}

		return state !== undefined && state.active > 0
			? WAIT_FOR_SETTLEMENT
			: undefined
	}

	public charge(state = this.createState(), time: number): HttpResponseState {
		const budget = state.budget

		if (budget !== undefined && budget.resetAt > time) {
			budget.remaining--
		}
		else {
			state.budget = undefined
			state.retryAt = undefined
			state.isProbing = true
		}

		state.active++

		return state
	}

	public trackSettlement(state: HttpResponseState, context: SettlementContext): (outcome: TaskOutcome<TResponse>) => void {
		const chargedResetAt = state.budget?.resetAt
		const { id, key, isCurrent, readTime, log } = context

		return outcome => {
			try {
				if (!isCurrent()) {
					log(LogLevel.VERBOSE, 'HTTP SETTLEMENT IGNORED', () => ({ id, key, reason: 'generation' }))

					return
				}

				const settledAt = readTime()
				const feedback = this._getFeedback(outcome, settledAt, context)

				if (feedback === null)
					return

				const time = readTime()

				if (isCurrent())
					this._applyFeedback(state, feedback, chargedResetAt, time, context)
				else
					log(LogLevel.VERBOSE, 'HTTP FEEDBACK IGNORED', () => ({ id, key, reason: 'generation' }))
			}
			finally {
				state.active--

				if (chargedResetAt === undefined)
					state.isProbing = false
			}
		}
	}

	public getStatus(state: HttpResponseState | undefined, time: number): HttpResponseBasedStatus {
		if (state?.retryAt !== undefined && state.retryAt > time)
			return { status: 'cooling-down', retryAt: state.retryAt }

		const budget = state?.budget

		if (budget !== undefined && budget.resetAt > time)
			return { status: 'known', remaining: budget.remaining, resetAt: budget.resetAt }

		return { status: state?.isProbing === true ? 'probing' : 'unknown' }
	}

	private _getFeedback(outcome: TaskOutcome<TResponse>, time: number, context: SettlementContext): HttpFeedback | null {
		const { id, key, log } = context

		try {
			const response = outcome.status === 'fulfilled'
				? outcome.value
				: this._responseFromError?.(outcome.reason)

			if (!context.isCurrent())
				return null

			const feedback = this._normalizeFeedback(this._extractFeedback(response ?? null, time))

			if (feedback !== undefined)
				return feedback

			log(LogLevel.WARNING, 'HTTP FEEDBACK INVALID', () => ({ id, key }))
		}
		catch {
			log(LogLevel.WARNING, 'HTTP EXTRACTOR FAILED', () => ({ id, key }))
		}

		return null
	}

	private _normalizeFeedback(feedback: unknown): HttpFeedback | null | undefined {
		if (feedback === null)
			return null

		if (typeof feedback !== 'object' || !('kind' in feedback))
			return undefined

		if (feedback.kind === 'rate-limited') {
			const retryAt = 'retryAt' in feedback ? feedback.retryAt : undefined

			return {
				kind: 'rate-limited',
				retryAt: typeof retryAt === 'number' && Number.isFinite(retryAt) ? retryAt : undefined,
			}
		}

		if (feedback.kind === 'quota' && 'remaining' in feedback && 'resetAt' in feedback) {
			const { remaining, resetAt } = feedback

			if (
				typeof remaining === 'number' && Number.isSafeInteger(remaining) && remaining >= 0
				&& typeof resetAt === 'number' && Number.isFinite(resetAt)
			)
				return { kind: 'quota', remaining, resetAt }
		}

		return undefined
	}

	private _applyFeedback(
		state: HttpResponseState,
		feedback: HttpFeedback,
		chargedResetAt: number | undefined,
		time: number,
		{ id, key, log }: SettlementContext,
	): void {
		if (feedback.kind === 'rate-limited') {
			const previousRetryAt = state.retryAt ?? -Infinity
			const retryAt = feedback.retryAt !== undefined && feedback.retryAt > time
				? feedback.retryAt
				: addTimestampDelay(time, this._fallbackResetDelayMs)

			state.budget = undefined
			state.retryAt = Math.max(previousRetryAt, retryAt)

			if (retryAt > previousRetryAt)
				log(LogLevel.DEBUG, 'HTTP COOLDOWN STARTED', () => ({ id, key, retryAfterMs: retryAt - time }))

			return
		}

		const { remaining, resetAt } = feedback
		const budget = state.budget

		if (resetAt <= time || (chargedResetAt !== undefined && (chargedResetAt !== resetAt || budget?.resetAt !== resetAt))) {
			log(LogLevel.VERBOSE, 'HTTP FEEDBACK IGNORED', () => ({ id, key, reason: 'window' }))

			return
		}

		if (chargedResetAt === undefined) {
			state.budget = { remaining, resetAt }
			log(LogLevel.DEBUG, 'HTTP BUDGET INSTALLED', () => ({ id, key, remaining, resetAt }))
		}
		else if (budget !== undefined && remaining < budget.remaining) {
			budget.remaining = remaining
			log(LogLevel.DEBUG, 'HTTP BUDGET TIGHTENED', () => ({ id, key, remaining, resetAt }))
		}
	}
}
