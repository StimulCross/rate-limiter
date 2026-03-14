/** @internal */
export abstract class CustomError extends Error {
	protected constructor(message: string) {
		super(message);

		Reflect.setPrototypeOf(this, new.target.prototype);

		this.name = new.target.name;

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		Error.captureStackTrace?.(this, new.target);
	}
}
