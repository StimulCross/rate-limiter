import { InvalidCostError } from '../errors/invalid-cost.error.js';

/** @internal */
export function validateCost(cost: number, max?: number, min?: number): void {
	if (!Number.isSafeInteger(cost) || cost < 0) {
		throw new InvalidCostError(`Invalid cost: ${cost}. Cost must be a positive integer.`, cost);
	}

	if (max !== undefined && cost > max) {
		throw new InvalidCostError(`Invalid cost: ${cost}. Cost must be greater than or equal to ${max}.`, cost);
	}

	if (min !== undefined && cost < min) {
		throw new InvalidCostError(`Invalid cost: ${cost}. Cost must be greater than or equal to ${min}.`, cost);
	}
}
