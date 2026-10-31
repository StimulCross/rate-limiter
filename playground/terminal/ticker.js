import { RateLimitErrorCode } from '@stimulcross/rate-limiter'
import { EVENT_MARKERS } from './markers.js'

const HISTORY_SIZE = 32
const BADGE_WIDTH = 7

const DROPS = {
	[RateLimitErrorCode.LimitExceeded]: { label: 'REJECT', marker: 'R' },
	[RateLimitErrorCode.QueueOverflow]: { label: 'FULL', marker: 'F' },
	[RateLimitErrorCode.Expired]: { label: 'EXPIRED', marker: 'X' },
	[RateLimitErrorCode.Cancelled]: { label: 'CANCEL', marker: 'C' },
	[RateLimitErrorCode.Cleared]: { label: 'CLEARED', marker: 'L' },
	[RateLimitErrorCode.Destroyed]: { label: 'CLOSED', marker: 'D' },
}

function getOutcome(event, detail) {
	if (event === 'DROP') {
		const result = DROPS[detail.split(' ', 1)[0]] ?? { label: 'DROP', marker: 'R' }

		return { ...result, style: EVENT_MARKERS[result.marker].style }
	}

	if (event === 'ERROR')
		return { label: 'ERROR', marker: 'E', style: EVENT_MARKERS.E.style }

	if (detail.startsWith('HTTP ')) {
		const status = Number(detail.slice(5))

		if (status >= 400) {
			const marker = status === 429
				? 'H'
				: 'E'

			return {
				label: String(status),
				marker,
				style: EVENT_MARKERS[marker].style,
			}
		}

		return {
			label: String(status),
			style: 'green',
		}
	}

	return { label: 'OK', style: 'green' }
}

function getTickerParts(title, entries, width, getBadge) {
	const heading = `${title.padEnd(8)} │ `
	const tiles = []
	let available = width - heading.length

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]
		const { label, style } = getBadge(entry)
		const taskName = `${entry.id}@${entry.key}`
		const space = tiles.length === 0
			? 0
			: 1
		const nameWidth = available - BADGE_WIDTH - 3 - space

		if (tiles.length > 0 && taskName.length > nameWidth)
			break

		const visibleName = taskName.length > nameWidth && nameWidth > 0
			? `${taskName.slice(0, nameWidth - 1)}…`
			: taskName
		const tile = nameWidth > 0
			? `[${visibleName} ${label.padEnd(BADGE_WIDTH)}]`
			: label
		tiles.push([tile, style])
		available -= tile.length + space
	}

	const parts = [
		[heading, 'bold'],
	]

	if (tiles.length === 0)
		parts.push(['—', 'dim'])

	for (const [index, tile] of tiles.reverse().entries()) {
		if (index > 0)
			parts.push([' '])

		parts.push(tile)
	}

	return parts
}

export function createTicker() {
	const arrivals = new Map()
	const results = []

	function record(event, { id, key }, detail) {
		if (event === 'IN') {
			arrivals.set(id, { id, key })

			if (arrivals.size > HISTORY_SIZE)
				arrivals.delete(arrivals.keys().next().value)

			return
		}

		const entry = arrivals.get(id)

		if (event === 'START') {
			if (entry)
				entry.badge = { label: 'RUN', style: 'green' }

			return
		}

		if (event === 'DONE' || event === 'DROP' || event === 'ERROR') {
			const badge = getOutcome(event, detail)

			if (entry)
				entry.badge = badge

			results.push({ id, key, badge })

			if (results.length > HISTORY_SIZE)
				results.shift()

			return badge
		}
	}

	return {
		record,
		getLines(width, isQuotaBlocked) {
			return [
				getTickerParts('ARRIVALS', [
					...arrivals.values(),
				], width, entry => entry.badge ?? (isQuotaBlocked(entry.key)
					? { label: 'QUOTA', style: 'yellow' }
					: { label: 'QUEUE', style: 'cyan' })),
				getTickerParts('RESULTS', results, width, entry => entry.badge),
			]
		},
	}
}
