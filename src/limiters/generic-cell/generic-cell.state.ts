/** @internal */
export interface ArrivalTime {
	whole: bigint
	fraction: number
}

/** @internal */
export interface GenericCellState {
	readonly arrivals: ArrivalTime[]
	nextAvailableAt: number
}
