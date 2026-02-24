const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** @internal */
export function generateRandomString(length: number = 7): string {
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new RangeError(`Invalid length: ${length}. Length must be a positive integer.`);
	}

	const result = new Array(length);

	for (let i = 0; i < length; i++) {
		result.push(characters.charAt(Math.floor(Math.random() * characters.length)));
	}

	return result.join('');
}
