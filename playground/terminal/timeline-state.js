import { EVENT_MARKERS, STATE_MARKERS } from './markers.js'
import { createTicker } from './ticker.js'

function readQuota(status, now) {
	const readyAt = status.nextAvailableAt ?? status.retryAt
		?? (status.status === 'known' && status.remaining === 0
			? status.resetAt
			: undefined)

	if (readyAt > now) {
		return Number.isFinite(readyAt)
			? `${Math.ceil(readyAt - now)} ms`
			: 'no finite boundary'
	}

	return status.status === 'probing'
		? 'probe response'
		: undefined
}

export function createTimelineState(tasks, keys, stepMs, historySteps) {
	const lanes = new Map()

	for (const key of new Set([
		...keys,
		...tasks.map(task => task.key),
	])) {
		lanes.set(key, {
			upcoming: new Set(),
			waiting: new Set(),
			running: new Set(),
			history: new Map(),
			events: new Map(),
			lastEvent: '',
		})
	}

	for (const task of tasks)
		lanes.get(task.key).upcoming.add(task)

	const ticker = createTicker()

	function record(event, task, detail, wasQueued, now) {
		const badge = ticker.record(event, task, detail)
		const lane = lanes.get(task.key)

		if (badge?.marker) {
			const step = Math.floor(now / stepMs)
			const previous = lane.events.get(step)

			lane.events.set(step, previous && previous.marker !== badge.marker
				? { marker: '+', style: EVENT_MARKERS['+'].style }
				: badge)
		}

		if (event === 'IN') {
			lane.upcoming.delete(task)
			lane.waiting.add(task.id)
		}
		else if (event === 'START') {
			const resumed = lane.quotaBlocked
				|| (lane.running.size === 0 && lane.idleSince !== undefined && now - lane.idleSince >= stepMs)
			lane.waiting.delete(task.id)
			lane.running.add(task.id)

			lane.transfer = {
				id: task.id,
				source: wasQueued ? 'QUEUE' : 'IN',
				at: now,
			}

			if (resumed) {
				lane.history.set(Math.floor(now / stepMs), '>')
				lane.resumedAt = now
			}

			lane.quotaBlocked = false
			lane.lastEvent = `+${now} ms ${resumed ? 'RESUMED' : 'START'} ${task.id}`
			lane.eventStyle = resumed ? STATE_MARKERS['>'].style : STATE_MARKERS.R.style

			return
		}
		else if (event === 'DONE' || event === 'DROP' || event === 'ERROR') {
			if (lane.running.delete(task.id) && lane.running.size === 0)
				lane.idleSince = now

			lane.waiting.delete(task.id)
		}
		else {
			return
		}

		lane.lastEvent = `+${now} ms ${event} ${task.id} ${detail}`.trimEnd()

		lane.eventStyle = badge?.marker ? badge.style : undefined
	}

	function sample(statuses, epoch, step) {
		let index = 0

		for (const lane of lanes.values()) {
			const status = statuses[index++]
			const remaining = readQuota(status, epoch)
			lane.quotaBlocked = lane.waiting.size > 0 && remaining !== undefined
			let current = '.'

			if (lane.quotaBlocked) {
				current = lane.running.size > 0
					? 'B'
					: 'Q'
			}
			else if (lane.running.size > 0) {
				current = lane.waiting.size > 0
					? '*'
					: 'R'
			}
			else if (lane.waiting.size > 0) {
				current = 'W'
			}

			if (lane.history.get(step) !== '>')
				lane.history.set(step, current)

			for (const old of lane.history.keys()) {
				if (old < step - historySteps)
					lane.history.delete(old)
			}

			for (const old of lane.events.keys()) {
				if (old < step - historySteps)
					lane.events.delete(old)
			}

			lane.remaining = remaining
			lane.needsProbe = status.status === 'unknown'
		}
	}

	return {
		lanes,
		record,
		sample,
		getTickerLines: width => ticker.getLines(width, key => lanes.get(key).quotaBlocked),
	}
}
