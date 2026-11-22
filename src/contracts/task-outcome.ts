/** @internal */
export type TaskOutcome<TResult> =
	| {
		readonly status: 'fulfilled'
		readonly value: TResult
	}
	| {
		readonly status: 'rejected'
		readonly reason: unknown
	}
