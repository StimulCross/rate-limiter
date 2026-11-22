/** @internal */
export interface HttpBudget {
	remaining: number
	readonly resetAt: number
}

/** @internal */
export interface HttpResponseState {
	active: number
	isProbing: boolean
	budget?: HttpBudget
	retryAt?: number
}
