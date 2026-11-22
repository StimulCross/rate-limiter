import type { FixedWindowBounds } from './fixed-window.status.js'

/** @internal */
export interface FixedWindowUsage extends FixedWindowBounds {
	used: number
}

/** @internal */
export interface FixedWindowState {
	lastObservedTime: number
	windows: readonly FixedWindowUsage[]
}
