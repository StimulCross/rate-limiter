const MAX_TIMEOUT_MS = 2_147_483_647

interface ScheduledTimeout {
	readonly at: number
	readonly handle: ReturnType<typeof setTimeout>
}

/** @internal */
export class ScheduledAlarm {
	private _scheduled?: ScheduledTimeout

	constructor(private readonly _wake: () => void) {}

	public schedule(at: number | undefined, now: number): void {
		if (this._scheduled?.at === at)
			return

		this.cancel()

		if (at === undefined)
			return

		const delay = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.ceil(at - now)))

		const scheduled: ScheduledTimeout = {
			at,
			handle: setTimeout(
				() => {
					if (this._scheduled === scheduled) {
						this._scheduled = undefined
						this._wake()
					}
				},
				delay,
			),
		}

		this._scheduled = scheduled
	}

	public cancel(): void {
		const scheduled = this._scheduled

		if (scheduled !== undefined) {
			this._scheduled = undefined
			clearTimeout(scheduled.handle)
		}
	}
}
