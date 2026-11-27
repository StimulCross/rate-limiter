import type { BinaryHeapHandle } from '@stimulcross/ds-binary-heap'
import type { PriorityMode } from '../contracts/priority-mode.js'
import type { PriorityWeights } from '../contracts/priority-weights.js'
import type { Priority } from '../contracts/priority.js'
import { IndexedBinaryHeap } from '@stimulcross/ds-binary-heap'
import { getPriorityBit, PRIORITIES, PrioritySelector } from './priority-selector.js'

interface WaitingKey<Payload> {
	readonly key: string
	readonly groups: (WaitingGroup<Payload> | undefined)[]
	isReady: boolean
	oldest?: Task<Payload>
	bypasses: bigint
}

interface WaitingGroup<Payload> {
	readonly owner: WaitingKey<Payload>
	head?: Task<Payload>
	tail?: Task<Payload>
	offered?: Task<Payload>
	offeredHandle?: BinaryHeapHandle
}

/** @internal */
export interface Task<Payload> {
	readonly key: string
	readonly priority: Priority
	readonly payload: Payload
	rank: bigint
	group?: WaitingGroup<Payload>
	previous?: Task<Payload>
	next?: Task<Payload>
}

function compareRanks<Payload>(left: Task<Payload>, right: Task<Payload>): number {
	return Number(left.rank - right.rank)
}

/** @internal */
export class Scheduler<Payload> {
	private readonly _keys = new Map<string, WaitingKey<Payload>>()
	private readonly _ready: IndexedBinaryHeap<Task<Payload>>[] = []
	private readonly _selector?: PrioritySelector
	private readonly _capacityWithArrival: number
	private readonly _rankLimit: bigint
	private _nextRank = 0n
	private _size = 0

	constructor(capacity: number, priorityMode: PriorityMode, weights?: PriorityWeights) {
		if (!Number.isSafeInteger(capacity) || capacity < 0)
			throw new RangeError('Waiting capacity must be a nonnegative safe integer')

		this._capacityWithArrival = capacity + 1
		this._rankLimit = 2n * BigInt(this._capacityWithArrival)

		if (priorityMode === 'weighted')
			this._selector = new PrioritySelector(weights)

		for (const priority of PRIORITIES)
			this._ready[priority - 1] = new IndexedBinaryHeap<Task<Payload>>(compareRanks)
	}

	public get size(): number {
		return this._size
	}

	/**
	 * Includes the candidate at its submission position. One transient arrival
	 * may coexist with a full queue while the coordinator decides admission.
	 */
	public enqueue(key: string, priority: Priority, payload: Payload, isReady: boolean): Task<Payload> {
		if (this._size >= this._capacityWithArrival)
			throw new RangeError('Waiting index has no room for another arrival')

		if (this._nextRank >= this._rankLimit)
			this._relabel()

		let owner = this._keys.get(key)

		if (owner === undefined) {
			owner = {
				key,
				groups: [],
				isReady,
				bypasses: 0n,
			}

			this._keys.set(key, owner)
		}

		const group = owner.groups[priority - 1] ??= { owner }
		const previous = group.tail
		const task: Task<Payload> = {
			key,
			priority,
			payload,
			rank: this._nextRank,
			group,
			previous,
		}

		this._nextRank++
		this._size++
		group.tail = task

		if (previous === undefined)
			group.head = task
		else
			previous.next = task

		if (previous === undefined || owner.isReady !== isReady) {
			owner.isReady = isReady
			this._refresh(owner)
		}

		return task
	}

	public setReady(key: string, isReady: boolean): void {
		const owner = this._keys.get(key)

		if (owner !== undefined && owner.isReady !== isReady) {
			owner.isReady = isReady
			this._refresh(owner)
		}
	}

	/**
	 * Visits one key's waiters. The caller may remove the yielded task.
	 */
	public* getTasks(key: string): IterableIterator<Task<Payload>> {
		const owner = this._keys.get(key)

		if (owner === undefined)
			return

		for (const group of owner.groups) {
			let task = group?.head

			while (task !== undefined) {
				const next = task.next
				yield task
				task = next
			}
		}
	}

	public select(): Task<Payload> | undefined {
		return this._select(this._selector ? this._getOfferedMask() : 0)
	}

	/**
	 * Commits a start only if the task still wins the current decision.
	 */
	public start(task: Task<Payload>): boolean {
		const mask = this._selector ? this._getOfferedMask() : 0
		const group = task.group

		if (group === undefined || this._select(mask) !== task)
			return false

		if (this._selector) {
			this._selector.recordStart(mask, task.priority)

			if (group.owner.oldest !== task)
				group.owner.bypasses++
		}

		this._unlink(task, group)

		return true
	}

	public remove(task: Task<Payload>): boolean {
		const group = task.group

		if (group === undefined || this._keys.get(task.key) !== group.owner)
			return false

		this._unlink(task, group)

		return true
	}

	private _unlink(task: Task<Payload>, group: WaitingGroup<Payload>): void {
		const { previous, next } = task

		if (previous === undefined)
			group.head = next
		else
			previous.next = next

		if (next === undefined)
			group.tail = previous
		else
			next.previous = previous

		task.previous = undefined
		task.next = undefined
		task.group = undefined
		this._size--

		// A non-head removal changes neither the oldest task nor the offers.
		if (previous === undefined)
			this._refresh(group.owner)
	}

	private _refresh(owner: WaitingKey<Payload>): void {
		const protectedTask = this._selector ? this._refreshProtection(owner, this._selector) : undefined
		let hasWaiters = false

		for (const priority of PRIORITIES) {
			const index = priority - 1
			const group = owner.groups[index]

			if (group === undefined)
				continue

			const head = group.head
			const offered = owner.isReady && (!protectedTask || head === protectedTask)
				? head
				: undefined

			if (group.offered !== offered) {
				const heap = this._ready[index]

				if (group.offeredHandle !== undefined)
					heap.remove(group.offeredHandle)

				group.offeredHandle = offered === undefined
					? undefined
					: heap.push(offered)

				group.offered = offered
			}

			if (head === undefined)
				owner.groups[index] = undefined
			else
				hasWaiters = true
		}

		if (!hasWaiters)
			this._keys.delete(owner.key)
	}

	private _refreshProtection(owner: WaitingKey<Payload>, selector: PrioritySelector): Task<Payload> | undefined {
		let oldest: Task<Payload> | undefined

		for (const group of owner.groups) {
			const head = group?.head

			if (head && (!oldest || head.rank < oldest.rank))
				oldest = head
		}

		if (owner.oldest !== oldest) {
			owner.oldest = oldest
			owner.bypasses = 0n
		}

		return oldest && owner.bypasses >= selector.getBypassLimit(oldest.priority) ? oldest : undefined
	}

	private _getOfferedMask(): number {
		let mask = 0

		for (const priority of PRIORITIES) {
			if (this._ready[priority - 1].peek() !== undefined)
				mask |= getPriorityBit(priority)
		}

		return mask
	}

	private _select(mask: number): Task<Payload> | undefined {
		if (!this._selector) {
			for (const priority of PRIORITIES) {
				const task = this._ready[priority - 1].peek()

				if (task)
					return task
			}

			return undefined
		}

		const priority = this._selector.select(mask)

		return priority ? this._ready[priority - 1].peek() : undefined
	}

	private _relabel(): void {
		const tasks: Task<Payload>[] = []

		for (const owner of this._keys.values()) {
			for (const group of owner.groups) {
				for (let task = group?.head; task !== undefined; task = task.next)
					tasks.push(task)
			}
		}

		// Preserving the relative order preserves every heap and FIFO invariant.
		tasks.sort(compareRanks)
		this._nextRank = 0n

		for (const task of tasks) {
			task.rank = this._nextRank
			this._nextRank++
		}
	}
}
