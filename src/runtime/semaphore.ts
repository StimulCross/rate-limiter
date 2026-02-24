/** @internal */
export class Semaphore {
	private _permits: number;

	constructor(private readonly _maxPermits: number | null) {
		if (_maxPermits !== null && (!Number.isSafeInteger(_maxPermits) || _maxPermits <= 0)) {
			throw new Error('Maximum permits must be a non-negative integer or null');
		}

		this._permits = _maxPermits ?? 0;
	}

	public acquire(): boolean {
		if (this._maxPermits === null) {
			return true;
		}

		if (this._permits > 0) {
			this._permits--;
			return true;
		}

		return false;
	}

	public release(): void {
		if (this._maxPermits !== null && this._permits < this._maxPermits) {
			this._permits++;
		}
	}
}
