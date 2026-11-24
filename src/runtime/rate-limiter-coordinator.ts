import type { BinaryHeapHandle } from '@stimulcross/ds-binary-heap'
import type { Clock } from '../contracts/clock.js'
import type { CoordinatorPolicy, QuotaBlock, SettleTask } from '../contracts/coordinator-policy.js'
import type { IdGenerator } from '../contracts/id-generator.js'
import type { LimitBehavior } from '../contracts/limit-behavior.js'
import type { PriorityWeights } from '../contracts/priority-weights.js'
import type { RateLimiterOptions } from '../contracts/rate-limiter-options.js'
import type { RateLimiterRunOptions } from '../contracts/rate-limiter-run-options.js'
import type { TaskOutcome } from '../contracts/task-outcome.js'
import type { Task } from './scheduler.js'
import { IndexedBinaryHeap } from '@stimulcross/ds-binary-heap'
import { LogLevel } from '@stimulcross/logger'
import { Priority } from '../contracts/priority.js'
import { RateLimitErrorCode } from '../errors/rate-limit-error-code.js'
import { RateLimitError } from '../errors/rate-limit.error.js'
import { createLimiterLogger } from '../utils/limiter-logging.js'
import { ScheduledAlarm } from '../utils/scheduled-alarm.js'
import { PRIORITIES } from './priority-selector.js'
import { Scheduler } from './scheduler.js'

type RateLimiterCoordinatorOptions = RateLimiterOptions & {
	readonly weights?: PriorityWeights
}

interface CoordinatorClocks {
	readonly quotaClock?: Clock
	readonly waitingClock?: Clock
}

interface KeyRecord<State> {
	readonly key: string
	state?: State
	observedAt: number
	wakeAt: number
	wakeHandle?: BinaryHeapHandle
	waiters: number
}

interface PendingStart<State, TResult> {
	readonly key: KeyRecord<State>
	readonly invoke: (settle?: SettleTask<TResult>) => void
	readonly reject: (reason: unknown) => void
	readonly deadline: number
	readonly id?: string
	readonly signal?: AbortSignal
	isQueued?: true
	deadlineHandle?: BinaryHeapHandle
}

type PendingTask<State, TResult> = Task<PendingStart<State, TResult>>

interface AbortGroup<State, TResult> {
	readonly waiters: Set<PendingTask<State, TResult>>
	readonly dependent: AbortSignal
	readonly listener: () => void
}

interface DecisionTime {
	readonly epoch: number
	readonly monotonic: number
}

const DEFAULT_KEY = ''

const EPOCH_CLOCK: Clock = {
	now: () => Date.now(),
}

const MONOTONIC_CLOCK: Clock = {
	now: () => performance.now(),
}

function compareWakeups(left: KeyRecord<unknown>, right: KeyRecord<unknown>): number {
	return left.wakeAt - right.wakeAt
}

function compareDeadlines(left: Task<{ readonly deadline: number }>, right: Task<{ readonly deadline: number }>): number {
	return left.payload.deadline - right.payload.deadline || Number(left.rank - right.rank)
}

function readTime(clock: Clock): number {
	const time = clock.now()

	if (!Number.isFinite(time))
		throw new RangeError('Clock must return a finite number')

	return time
}

function validateMaxWait(maxWaitMs: number): void {
	if (!(maxWaitMs >= 0))
		throw new RangeError('Maximum wait must be nonnegative')
}

/** @internal */
export class RateLimiterCoordinator<TState, TStatus, TResult = unknown> {
	private readonly _scheduler: Scheduler<PendingStart<TState, TResult>>
	private readonly _keys = new Map<string, KeyRecord<TState>>()
	private readonly _wakeups = new IndexedBinaryHeap<KeyRecord<TState>>(compareWakeups)
	private readonly _deadlines = new IndexedBinaryHeap<PendingTask<TState, TResult>>(compareDeadlines)
	private readonly _quotaAlarm = new ScheduledAlarm(() => this._drain())
	private readonly _deadlineAlarm = new ScheduledAlarm(() => this._drain())
	private readonly _abortGroups = new Map<AbortSignal, AbortGroup<TState, TResult>>()
	private readonly _capacity: number | undefined
	private readonly _concurrency: number
	private readonly _maxWaitMs: number
	private readonly _limitBehavior: LimitBehavior
	private readonly _idGenerator?: IdGenerator
	private readonly _quotaClock: Clock
	private readonly _waitingClock: Clock
	private readonly _log: ReturnType<typeof createLimiterLogger>
	private _active = 0
	private _isDraining = false
	private _shutdown?: PromiseWithResolvers<undefined>

	constructor(
		private readonly _policy: CoordinatorPolicy<TState, TStatus, TResult>,
		options: RateLimiterCoordinatorOptions = {},
		context = 'RateLimiterCoordinator',
		clocks: CoordinatorClocks = {},
	) {
		const { queue, limitBehavior = 'reject' } = options
		const { capacity, concurrency = Infinity, maxWaitMs = Infinity } = queue ?? {}

		if (concurrency !== Infinity && (!Number.isSafeInteger(concurrency) || concurrency <= 0))
			throw new RangeError('Concurrency must be a positive safe integer or Infinity')

		validateMaxWait(maxWaitMs)

		if (limitBehavior === 'enqueue' && capacity === undefined)
			throw new RangeError('Enqueue requires an explicit waiting capacity')

		this._capacity = capacity
		this._concurrency = concurrency
		this._maxWaitMs = maxWaitMs
		this._limitBehavior = limitBehavior
		this._idGenerator = options.idGenerator
		this._quotaClock = clocks.quotaClock ?? EPOCH_CLOCK
		this._waitingClock = clocks.waitingClock ?? MONOTONIC_CLOCK
		this._scheduler = new Scheduler(capacity ?? 0, options.weights)
		this._log = createLimiterLogger(options.loggerOptions?.context || context, options.loggerOptions)
	}

	// eslint-disable-next-line ts/promise-function-async -- Return the same promise used to assimilate the callback result.
	public run<T extends TResult>(callback: () => T | PromiseLike<T>, options: RateLimiterRunOptions = {}): Promise<T> {
		const completion = Promise.withResolvers<T>()
		let hasStarted = false
		let isAdmitting = false
		let id: string | undefined
		let key: string | undefined
		let settle: SettleTask<TResult> | undefined

		const releaseSlot = (status: TaskOutcome<TResult>['status'], outcome?: TaskOutcome<TResult>): void => {
			if (!hasStarted)
				return

			if (outcome !== undefined) {
				try {
					settle?.(outcome)
				}
				catch (err) {
					this._logInternalFailure('settlement', err, key, id)
				}
			}

			this._active--
			const active = this._active
			this._log(LogLevel.VERBOSE, 'TASK SETTLED', () => ({ id, key, outcome: status, active }))
			this._onSlotReleased()
		}

		// register settlement before exposing the native promise to callers
		void completion.promise.then(
			value => releaseSlot('fulfilled', settle && { status: 'fulfilled', value }),
			(err: unknown) => releaseSlot('rejected', settle && { status: 'rejected', reason: err }),
		)

		try {
			id = options.id
			this._assertOpen(id)
			const submittedAt = readTime(this._waitingClock)
			const {
				key: quotaKey = DEFAULT_KEY,
				priority = Priority.Normal,
				limitBehavior = this._limitBehavior,
				maxWaitMs = this._maxWaitMs,
				signal,
			} = options
			key = quotaKey
			validateMaxWait(maxWaitMs)

			if (!PRIORITIES.includes(priority))
				throw new RangeError('Unknown task priority')

			if (limitBehavior === 'enqueue' && this._capacity === undefined)
				throw new RangeError('Enqueue requires an explicit waiting capacity')

			id ??= this._idGenerator?.()
			this._assertOpen(id, key)

			const deadline = maxWaitMs === 0 ? Infinity : submittedAt + maxWaitMs
			const time = this._readDecisionTime()
			const failure = this._getLivenessFailure(signal, deadline, time.monotonic)

			if (failure !== undefined) {
				const reason = new RateLimitError(failure, null, id)
				this._logRejection(LogLevel.DEBUG, reason, id, key)

				throw reason
			}

			isAdmitting = true
			this._reconcile(time)
			const record = this._keys.get(key) ?? {
				key,
				state: this._policy.createState?.(),
				observedAt: time.epoch,
				wakeAt: Infinity,
				waiters: 0,
			}
			const blockedUntil = this._checkQuota(record, time.epoch)
			const arrival = this._scheduler.enqueue(key, priority, {
				key: record,
				reject: completion.reject,
				deadline,
				id,
				signal,
				invoke: onSettlement => {
					hasStarted = true
					settle = onSettlement

					try {
						completion.resolve(callback())
					}
					catch (err) {
						completion.reject(err)
					}
				},
			}, blockedUntil === undefined)

			this._keys.set(key, record)
			record.waiters++
			this._publishReadiness(record, blockedUntil)

			const winner = this._checkout(time)

			if (arrival.group !== undefined) {
				if (limitBehavior === 'reject' || maxWaitMs === 0) {
					const retryAfterMs = Number.isFinite(record.wakeAt) ? record.wakeAt - time.epoch : null
					this._reject(arrival, new RateLimitError(RateLimitErrorCode.LimitExceeded, retryAfterMs), LogLevel.DEBUG)
				}
				else if (this._scheduler.size > (this._capacity ?? 0)) {
					this._reject(arrival, new RateLimitError(RateLimitErrorCode.QueueOverflow), LogLevel.DEBUG)
				}
				else {
					this._retain(arrival, time.epoch)
				}
			}

			this._scheduleAlarms(time)
			isAdmitting = false

			if (winner !== undefined) {
				this._invoke(winner)
				this._drain()
			}
		}
		catch (err) {
			if (isAdmitting)
				this._logInternalFailure('admission', err, key, id)

			completion.reject(err)
		}

		return completion.promise
	}

	public clear(key?: string): void {
		const reason = new RateLimitError(RateLimitErrorCode.Cleared)

		if (key === undefined) {
			const rejectedWaiting = this._scheduler.size
			this._reset(reason)
			this._log(LogLevel.DEBUG, 'LIMITER CLEARED', () => ({ scope: 'instance', rejectedWaiting }))

			return
		}

		const record = this._keys.get(key)
		const rejectedWaiting = record?.waiters ?? 0

		if (record !== undefined) {
			this._rejectKey(record, reason, LogLevel.VERBOSE)
			this._keys.delete(key)
		}

		this._log(LogLevel.DEBUG, 'LIMITER CLEARED', () => ({ key, scope: 'key', rejectedWaiting }))

		if (record !== undefined)
			this._drain()
	}

	// eslint-disable-next-line ts/promise-function-async -- Repeated calls share the shutdown promise.
	public destroy(): Promise<void> {
		if (this._shutdown === undefined) {
			this._shutdown = Promise.withResolvers<undefined>()
			this._reset(new RateLimitError(RateLimitErrorCode.Destroyed))

			if (this._active === 0)
				this._completeShutdown(this._shutdown)
		}

		return this._shutdown.promise
	}

	/**
	 * Projects a key's quota without recording elapsed time or evaluating the queue.
	 */
	public getStatus(key = DEFAULT_KEY): TStatus {
		const epoch = readTime(this._quotaClock)
		const record = this._keys.get(key)

		return this._policy.getStatus(record?.state, Math.max(epoch, record?.observedAt ?? epoch))
	}

	private _assertOpen(id?: string, key?: string): void {
		if (this._shutdown !== undefined) {
			const reason = new RateLimitError(RateLimitErrorCode.Destroyed, null, id)
			this._logRejection(LogLevel.DEBUG, reason, id, key)

			throw reason
		}
	}

	private _onSlotReleased(): void {
		if (this._shutdown === undefined)
			this._drain()
		else if (this._active === 0)
			this._completeShutdown(this._shutdown)
	}

	private _completeShutdown(shutdown: PromiseWithResolvers<undefined>): void {
		this._log(LogLevel.INFO, 'LIMITER DESTROYED')
		shutdown.resolve(undefined)
	}

	private _readDecisionTime(): DecisionTime {
		return {
			epoch: readTime(this._quotaClock),
			monotonic: readTime(this._waitingClock),
		}
	}

	private _getLivenessFailure(signal: AbortSignal | undefined, deadline: number, now: number): RateLimitErrorCode | undefined {
		if (signal?.aborted)
			return RateLimitErrorCode.Cancelled

		return deadline <= now ? RateLimitErrorCode.Expired : undefined
	}

	private _checkQuota(key: KeyRecord<TState>, epoch: number): QuotaBlock {
		const time = Math.max(key.observedAt, epoch)
		const blockedUntil = this._policy.check(key.state, time)
		key.observedAt = time

		return blockedUntil
	}

	private _publishReadiness(key: KeyRecord<TState>, blockedUntil: QuotaBlock): void {
		this._scheduler.setReady(key.key, blockedUntil === undefined)
		const wakeAt = typeof blockedUntil === 'number' ? blockedUntil : Infinity

		if (key.wakeAt === wakeAt)
			return

		key.wakeAt = wakeAt

		if (key.waiters === 0 || !Number.isFinite(wakeAt))
			this._removeWakeup(key)
		else if (key.wakeHandle === undefined)
			key.wakeHandle = this._wakeups.push(key)
		else
			this._wakeups.update(key.wakeHandle, key)
	}

	private _removeWakeup(key: KeyRecord<TState>): void {
		if (key.wakeHandle !== undefined) {
			this._wakeups.remove(key.wakeHandle)
			key.wakeHandle = undefined
		}
	}

	private _reconcile(time: DecisionTime): void {
		for (
			let task = this._deadlines.peek();
			task !== undefined && task.payload.deadline <= time.monotonic;
			task = this._deadlines.peek()
		)
			this._reject(task, new RateLimitError(RateLimitErrorCode.Expired), LogLevel.DEBUG)

		for (let key = this._wakeups.peek(); key !== undefined && key.wakeAt <= time.epoch; key = this._wakeups.peek()) {
			try {
				this._publishReadiness(key, this._checkQuota(key, time.epoch))
			}
			catch (err) {
				this._logInternalFailure('quota', err, key.key)
				this._rejectKey(key, err)
			}
		}
	}

	private _checkout(time: DecisionTime): PendingTask<TState, TResult> | undefined {
		while (this._active < this._concurrency) {
			const candidate = this._scheduler.select()

			if (candidate === undefined)
				return undefined

			const { key, signal, deadline } = candidate.payload
			const failure = this._getLivenessFailure(signal, deadline, time.monotonic)

			if (failure !== undefined) {
				this._reject(candidate, new RateLimitError(failure), LogLevel.DEBUG)

				continue
			}

			let blockedUntil: QuotaBlock

			try {
				blockedUntil = this._checkQuota(key, time.epoch)
			}
			catch (err) {
				this._logInternalFailure('quota', err, key.key)
				this._rejectKey(key, err)

				continue
			}

			if (blockedUntil !== undefined) {
				this._publishReadiness(key, blockedUntil)

				continue
			}

			if (this._scheduler.start(candidate)) {
				this._active++
				key.state = this._policy.charge(key.state, key.observedAt)
				this._detach(candidate)

				if (key.waiters > 0)
					this._publishReadiness(key, this._policy.check(key.state, key.observedAt))

				return candidate
			}
		}

		return undefined
	}

	private _retain(task: PendingTask<TState, TResult>, epoch: number): void {
		const { signal, deadline } = task.payload

		if (Number.isFinite(deadline))
			task.payload.deadlineHandle = this._deadlines.push(task)

		if (signal !== undefined)
			this._subscribeToAbort(signal, task)

		task.payload.isQueued = true
		const { key, priority, payload: { id } } = task
		const waiting = this._scheduler.size

		this._log(LogLevel.DEBUG, 'TASK QUEUED', () => ({
			id,
			key,
			priority: Priority[priority],
			waiting,
			capacity: this._capacity,
		}))

		const { wakeAt } = task.payload.key

		if (Number.isFinite(wakeAt))
			this._log(LogLevel.VERBOSE, 'QUOTA BLOCKED', () => ({ id, key, quotaReadyInMs: wakeAt - epoch }))
	}

	private _subscribeToAbort(signal: AbortSignal, task: PendingTask<TState, TResult>): void {
		let group = this._abortGroups.get(signal)

		if (group === undefined) {
			const waiters = new Set<PendingTask<TState, TResult>>()
			// The private dependent receives abort even if a listener stops the source event.
			const dependent = AbortSignal.any([signal])

			const listener = (): void => {
				const reason = new RateLimitError(RateLimitErrorCode.Cancelled)

				for (const pending of waiters)
					this._reject(pending, reason, LogLevel.DEBUG)

				this._drain()
			}

			group = { waiters, dependent, listener }
			this._abortGroups.set(signal, group)
			dependent.addEventListener('abort', listener)
		}

		group.waiters.add(task)
	}

	private _detach(task: PendingTask<TState, TResult>): void {
		const { key, signal, deadlineHandle } = task.payload

		if (deadlineHandle !== undefined) {
			this._deadlines.remove(deadlineHandle)
			task.payload.deadlineHandle = undefined
		}

		if (signal !== undefined) {
			const group = this._abortGroups.get(signal)

			if (group !== undefined && group.waiters.delete(task) && group.waiters.size === 0) {
				group.dependent.removeEventListener('abort', group.listener)
				this._abortGroups.delete(signal)
			}
		}

		key.waiters--

		if (key.waiters === 0) {
			this._removeWakeup(key)
			key.wakeAt = Infinity

			if (key.state === undefined)
				this._keys.delete(key.key)
		}
	}

	private _reject(task: PendingTask<TState, TResult>, reason: unknown, level?: LogLevel): void {
		if (this._scheduler.remove(task)) {
			this._detach(task)
			const { id } = task.payload

			if (level !== undefined && reason instanceof RateLimitError)
				this._logRejection(level, reason, id, task.key)

			task.payload.reject(id !== undefined && reason instanceof RateLimitError
				? new RateLimitError(reason.code, reason.retryAfterMs, id)
				: reason)
		}
	}

	private _rejectKey(key: KeyRecord<TState>, reason: unknown, level?: LogLevel): void {
		for (const task of this._scheduler.getTasks(key.key))
			this._reject(task, reason, level)
	}

	private _reset(reason: RateLimitError): void {
		this._quotaAlarm.cancel()
		this._deadlineAlarm.cancel()

		for (const key of this._keys.values()) {
			if (key.waiters > 0)
				this._rejectKey(key, reason, LogLevel.VERBOSE)
		}

		this._keys.clear()
	}

	private _scheduleAlarms(time: DecisionTime): void {
		this._quotaAlarm.schedule(this._wakeups.peek()?.wakeAt, time.epoch)
		this._deadlineAlarm.schedule(this._deadlines.peek()?.payload.deadline, time.monotonic)
	}

	private _invoke(task: PendingTask<TState, TResult>): void {
		const { key, priority, payload: { id, isQueued, invoke } } = task
		const waiting = this._scheduler.size
		const active = this._active

		this._log(LogLevel.DEBUG, 'TASK STARTED', () => ({
			id,
			key,
			source: isQueued ? 'queue' : 'immediate',
			priority: Priority[priority],
			waiting,
			active,
		}))

		const wasDraining = this._isDraining
		this._isDraining = true

		try {
			invoke(this._trackSettlement(task.payload.key, id))
		}
		finally {
			this._isDraining = wasDraining
		}
	}

	private _trackSettlement(record: KeyRecord<TState>, id?: string): SettleTask<TResult> | undefined {
		if (this._policy.trackSettlement === undefined || record.state === undefined)
			return undefined

		const { key } = record
		const isCurrent = (): boolean => this._keys.get(key) === record
		const settle = this._policy.trackSettlement(record.state, {
			id,
			key,
			isCurrent,
			readTime: () => {
				const epoch = readTime(this._quotaClock)
				record.observedAt = Math.max(record.observedAt, epoch)

				return record.observedAt
			},
			log: this._log,
		})

		return outcome => {
			try {
				settle(outcome)
			}
			finally {
				if (isCurrent() && record.waiters > 0)
					this._publishReadiness(record, this._policy.check(record.state, record.observedAt))
			}
		}
	}

	private _drain(): void {
		if (this._isDraining)
			return

		this._isDraining = true

		try {
			while (this._scheduler.size > 0) {
				const time = this._readDecisionTime()

				if (this._shutdown !== undefined)
					return

				this._reconcile(time)
				const start = this._checkout(time)
				this._scheduleAlarms(time)

				if (start === undefined)
					break

				this._invoke(start)
			}
		}
		catch (err) {
			this._logInternalFailure('drain', err)

			for (const key of this._keys.values()) {
				if (key.waiters > 0)
					this._rejectKey(key, err)
			}
		}
		finally {
			this._isDraining = false

			if (this._scheduler.size === 0) {
				this._quotaAlarm.cancel()
				this._deadlineAlarm.cancel()
			}
		}
	}

	private _logRejection(level: LogLevel, reason: RateLimitError, id?: string, key?: string): void {
		const { code, retryAfterMs } = reason

		this._log(level, 'TASK REJECTED', () => ({
			id,
			key,
			code,
			retryAfterMs: retryAfterMs ?? undefined,
		}))
	}

	private _logInternalFailure(phase: string, error: unknown, key?: string, id?: string): void {
		this._log(LogLevel.ERROR, 'LIMITER FAILED', () => ({ id, key, phase }), error)
	}
}
