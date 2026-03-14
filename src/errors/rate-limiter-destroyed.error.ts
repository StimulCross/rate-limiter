import { CustomError } from './custom.error.js';

/**
 * An error thrown when running a task on a destroyed rate limiter.
 */
export class RateLimiterDestroyedError extends CustomError {
	constructor() {
		super('Rate limiter has been destroyed and cannot be used.');
	}
}
