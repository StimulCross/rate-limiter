import { CustomError } from './custom.error.js';

export interface InvalidCostErrorPlainObject extends Error {
	cost: number;
}

/**
 * Error thrown when the cost is invalid.
 *
 * The cost must be a positive integer or zero.
 */
export class InvalidCostError extends CustomError {
	constructor(
		message: string,
		private readonly _cost: number,
	) {
		super(message);
	}

	public get cost(): number {
		return this._cost;
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	public toJSON(): InvalidCostErrorPlainObject {
		return {
			name: this.name,
			message: this.message,
			cost: this._cost,
			stack: this.stack,
		};
	}
}
