/** @internal */
export function sanitizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error('Non-error thrown. Check "cause" property', { cause: error });
}
