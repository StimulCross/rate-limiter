import type { RateLimitPolicy } from '../../contracts/rate-limit-policy.js'
import type { FixedWindowLimitOptions } from './fixed-window.options.js'
import type { FixedWindowState, FixedWindowUsage } from './fixed-window.state.js'
import type { FixedWindowBounds, FixedWindowStatus } from './fixed-window.status.js'

/** @internal */
export class FixedWindowPolicy implements RateLimitPolicy<FixedWindowState, FixedWindowStatus> {
	private readonly _profiles: readonly FixedWindowLimitOptions[]

	constructor(profiles: readonly FixedWindowLimitOptions[]) {
		if (profiles.length === 0)
			throw new RangeError('Fixed Window requires at least one profile')

		this._profiles = profiles.map(profile => {
			const { limit, windowMs } = profile

			if (!Number.isSafeInteger(limit) || limit <= 0)
				throw new RangeError('Fixed Window limit must be a positive safe integer')

			if (!Number.isFinite(windowMs) || windowMs <= 0)
				throw new RangeError('Fixed Window duration must be positive and finite')

			if (profile.alignment === 'grid') {
				const offset = profile.offsetMs ?? 0

				if (!Number.isFinite(offset))
					throw new RangeError('Fixed Window grid offset must be finite')

				return { ...profile, offsetMs: offset % windowMs }
			}

			return { ...profile }
		})
	}

	public check(state: FixedWindowState | undefined, now: number): number | undefined {
		const time = this._getEffectiveTime(state, now)
		let nextAvailableAt: number | undefined

		for (const [index, profile] of this._profiles.entries()) {
			const window = this._getActiveWindow(state, index, time)

			if (window === undefined)
				this._getWindowBounds(profile, time)
			else if (window.used === profile.limit)
				nextAvailableAt = Math.max(nextAvailableAt ?? window.end, window.end)
		}

		return nextAvailableAt
	}

	public charge(state: FixedWindowState | undefined, now: number): FixedWindowState {
		const time = this._getEffectiveTime(state, now)
		const current: FixedWindowState = state ?? { lastObservedTime: time, windows: [] }
		let windows: FixedWindowUsage[] | undefined

		for (const [index, profile] of this._profiles.entries()) {
			if (this._getActiveWindow(current, index, time) === undefined) {
				windows ??= current.windows.slice()

				windows[index] = {
					...this._getWindowBounds(profile, time),
					used: 0,
				}
			}
		}

		if (windows !== undefined)
			current.windows = windows

		for (const window of current.windows)
			window.used++

		current.lastObservedTime = time

		return current
	}

	public getStatus(state: FixedWindowState | undefined, now: number): FixedWindowStatus {
		const time = this._getEffectiveTime(state, now)
		let nextAvailableAt = time
		const profiles = this._profiles.map((profile, index) => {
			const active = this._getActiveWindow(state, index, time)
			const used = active?.used ?? 0
			let window: FixedWindowBounds | null = null

			if (active !== undefined) {
				window = { start: active.start, end: active.end }

				if (used === profile.limit)
					nextAvailableAt = Math.max(nextAvailableAt, active.end)
			}
			else {
				const bounds = this._getWindowBounds(profile, time)

				if (profile.alignment === 'grid')
					window = bounds
			}

			return {
				window,
				limit: profile.limit,
				used,
				remaining: profile.limit - used,
			}
		})

		return { nextAvailableAt, profiles }
	}

	private _getEffectiveTime(state: FixedWindowState | undefined, now: number): number {
		if (!Number.isFinite(now))
			throw new RangeError('Fixed Window timestamp must be finite')

		return Math.max(now, state?.lastObservedTime ?? now)
	}

	private _getActiveWindow(
		state: FixedWindowState | undefined,
		index: number,
		time: number,
	): FixedWindowUsage | undefined {
		const window = state?.windows[index]

		return window !== undefined && time < window.end
			? window
			: undefined
	}

	private _getWindowBounds(profile: FixedWindowLimitOptions, time: number): FixedWindowBounds {
		const { windowMs } = profile
		let start = time
		let end = time + windowMs

		if (profile.alignment === 'grid') {
			const offset = profile.offsetMs ?? 0
			let idx = Math.floor((time - offset) / windowMs)
			start = offset + idx * windowMs
			end = offset + (idx + 1) * windowMs

			if (time < start) {
				idx--
				end = start
				start = offset + idx * windowMs
			}
			else if (time >= end) {
				idx++
				start = end
				end = offset + (idx + 1) * windowMs
			}
		}

		if (!Number.isFinite(start) || !Number.isFinite(end) || !(start <= time && time < end))
			throw new RangeError('Fixed Window boundaries cannot be represented at this timestamp')

		return { start, end }
	}
}
