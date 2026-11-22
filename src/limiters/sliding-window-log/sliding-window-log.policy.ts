import type { RateLimitPolicy } from '../../contracts/rate-limit-policy.js'
import type { SlidingWindowLogLimitOptions } from './sliding-window-log.options.js'
import type { SlidingWindowLogState } from './sliding-window-log.state.js'
import type { SlidingWindowLogStatus } from './sliding-window-log.status.js'
import { Deque } from '@stimulcross/ds-deque'
import { addTimestampDelay } from '../../utils/next-timestamp.js'

/** @internal */
export class SlidingWindowLogPolicy implements RateLimitPolicy<SlidingWindowLogState, SlidingWindowLogStatus> {
	private readonly _profiles: readonly SlidingWindowLogLimitOptions[]
	private readonly _longestWindowMs: number

	constructor(profiles: readonly SlidingWindowLogLimitOptions[]) {
		if (profiles.length === 0)
			throw new RangeError('Sliding Window Log requires at least one profile')

		let longestWindowMs = 0

		this._profiles = profiles.map(({ limit, windowMs }) => {
			if (!Number.isSafeInteger(limit) || limit <= 0)
				throw new RangeError('Sliding Window Log limit must be a positive safe integer')

			if (!Number.isFinite(windowMs) || windowMs <= 0)
				throw new RangeError('Sliding Window Log duration must be positive and finite')

			longestWindowMs = Math.max(longestWindowMs, windowMs)

			return { limit, windowMs }
		})

		this._longestWindowMs = longestWindowMs
	}

	public check(history: SlidingWindowLogState | undefined, time: number): number | undefined {
		if (history === undefined)
			return undefined

		let nextAvailableAt: number | undefined

		for (const { limit, windowMs } of this._profiles) {
			if (history.size < limit)
				continue

			// eslint-disable-next-line ts/no-non-null-assertion
			const start = history.at(history.size - limit)!
			const expiry = addTimestampDelay(start, windowMs)

			if (expiry > time)
				nextAvailableAt = Math.max(nextAvailableAt ?? expiry, expiry)
		}

		return nextAvailableAt
	}

	public charge(history: SlidingWindowLogState | undefined, time: number): SlidingWindowLogState {
		const starts = history ?? new Deque<number>(1)
		let oldest = starts.peekHead()

		while (oldest !== undefined && addTimestampDelay(oldest, this._longestWindowMs) <= time) {
			starts.shift()
			oldest = starts.peekHead()
		}

		starts.push(time)

		return starts
	}

	public getStatus(history: SlidingWindowLogState | undefined, time: number): SlidingWindowLogStatus {
		const nextAvailableAt = this.check(history, time) ?? time
		const profiles = this._profiles.map(({ limit, windowMs }) => {
			const used = history === undefined
				? 0
				: this._countActiveStarts(history, time, windowMs)

			return {
				limit,
				windowMs,
				used,
				remaining: limit - used,
			}
		})

		return { nextAvailableAt, profiles }
	}

	private _countActiveStarts(history: SlidingWindowLogState, time: number, windowMs: number): number {
		let low = 0
		let high = history.size

		while (low < high) {
			const middle = low + Math.floor((high - low) / 2)
			// eslint-disable-next-line ts/no-non-null-assertion
			const start = history.at(middle)!

			if (addTimestampDelay(start, windowMs) <= time)
				low = middle + 1
			else
				high = middle
		}

		return history.size - low
	}
}
