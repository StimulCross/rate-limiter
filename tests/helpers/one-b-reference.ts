import { Priority } from '../../src/index.js'

/** @internal */
export const ASCENDING_PRIORITIES = [
	Priority.Lowest,
	Priority.Low,
	Priority.Normal,
	Priority.High,
	Priority.Highest,
] as const

/** @internal */
export type Fraction = readonly [numerator: bigint, denominator: bigint]

/** @internal */
export const ZERO: Fraction = [0n, 1n]

/** @internal */
export function compareFractions(left: Fraction, right: Fraction): bigint {
	return left[0] * right[1] - right[0] * left[1]
}

function addFractions([a, b]: Fraction, [c, d]: Fraction): Fraction {
	const numerator = a * d + b * c
	const denominator = b * d
	let left = numerator < 0n
		? -numerator
		: numerator
	let right = denominator

	while (right !== 0n)
		[left, right] = [right, left % right]

	return [numerator / left, denominator / left]
}

/** @internal */
export function chooseReference(
	weights: readonly bigint[],
	balances: readonly Fraction[],
	classes: ReadonlySet<Priority>,
): { winner: Priority, balances: Fraction[] } | undefined {
	const next = balances.slice()
	let total = 0n

	for (const priority of classes)
		total += weights[priority - 1]

	let winner: Priority | undefined

	for (const priority of classes) {
		const index = priority - 1
		next[index] = addFractions(next[index], [weights[index], total])

		if (winner === undefined) {
			winner = priority

			continue
		}

		const diff = compareFractions(next[index], next[winner - 1])

		if (diff > 0n || (diff === 0n && priority > winner))
			winner = priority
	}

	if (winner === undefined)
		return undefined

	next[winner - 1] = addFractions(next[winner - 1], [-1n, 1n])

	return { winner, balances: next }
}

/** @internal */
export interface ReferenceTask {
	readonly key: string
	readonly priority: Priority
	readonly payload: number
}

/** @internal */
export class OneBReference {
	public readonly tasks: ReferenceTask[] = []
	private readonly _bypasses = new Map<string, bigint>()
	private readonly _total: bigint
	private _balances = ASCENDING_PRIORITIES.map(() => ZERO)

	constructor(private readonly _weights: readonly bigint[]) {
		this._total = _weights.reduce((sum, weight) => sum + weight, 0n)
	}

	public enqueue(task: ReferenceTask): void {
		this.tasks.push(task)
	}

	public remove(task: ReferenceTask): void {
		const oldest = this.tasks.find(candidate => candidate.key === task.key)

		if (oldest === task)
			this._bypasses.delete(task.key)

		this.tasks.splice(this.tasks.indexOf(task), 1)
	}

	public start(ready: ReadonlySet<string>): ReferenceTask | undefined {
		const candidates = this.tasks.filter(task => {
			if (!ready.has(task.key))
				return false

			const oldest = this.tasks.find(candidate => candidate.key === task.key)

			if (oldest === undefined || oldest === task)
				return true

			const bypasses = this._bypasses.get(task.key) ?? 0n

			return (bypasses + 1n) * this._weights[oldest.priority - 1] < this._total
		})
		const decision = chooseReference(this._weights, this._balances, new Set(candidates.map(task => task.priority)))
		const task = candidates.find(candidate => candidate.priority === decision?.winner)

		if (task === undefined || decision === undefined)
			return undefined

		// Removing the oldest resets this count, including when the key becomes empty.
		this._bypasses.set(task.key, (this._bypasses.get(task.key) ?? 0n) + 1n)
		this.remove(task)
		this._balances = decision.balances

		return task
	}
}
