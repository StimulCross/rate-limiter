/**
 * An observational snapshot of one key's server quota state.
 */
export type HttpResponseBasedStatus =
	| {
		/**
		 * The key has a budget for the active server window.
		 */
		readonly status: 'known'

		/**
		 * Whole starts left after local debits and applicable server feedback.
		 */
		readonly remaining: number

		/**
		 * End of the active server window in Unix epoch milliseconds.
		 */
		readonly resetAt: number
	}
	| {
		/**
		 * The key is blocked by HTTP 429 feedback.
		 */
		readonly status: 'cooling-down'

		/**
		 * The cooldown end in Unix epoch milliseconds. An unrepresentable end is `Infinity`.
		 */
		readonly retryAt: number
	}
	| {
		/**
		 * The key has no budget, or is running a probe to establish a budget.
		 */
		readonly status: 'unknown' | 'probing'
	}
