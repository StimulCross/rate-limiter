import { type Clock } from '../core/clock.js';

/** @internal */
export const defaultClock: Clock = {
	now(): number {
		return Date.now();
	},
};
