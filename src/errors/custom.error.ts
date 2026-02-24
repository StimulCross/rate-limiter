/** @internal */
export abstract class CustomError extends Error {
	protected constructor(message: string) {
		super(message);

		Object.setPrototypeOf(this, new.target.prototype);
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		Error.captureStackTrace?.(this, new.target.constructor);
	}

	public get name(): string {
		return this.constructor.name;
	}
}
