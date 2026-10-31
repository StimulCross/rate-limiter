import { EVENT_MARKERS, STATE_MARKERS } from './markers.js'
import { paint } from './presentation.js'

const TRANSFER_MS = 700
const TRACK_WIDTH = 12

function formatLine(parts, width) {
	let remaining = width
	let line = ''

	for (const [text, style] of parts) {
		if (remaining === 0)
			break

		const visible = text.slice(0, remaining)

		line += paint(style, visible)

		remaining -= visible.length
	}

	return line
}

function getTransferParts(transfer, now, isFinal) {
	if (transfer === undefined) {
		return [
			['—', 'dim'],
		]
	}

	const { id, source, at } = transfer
	const progress = isFinal
		? 1
		: Math.min(1, (now - at) / TRANSFER_MS)
	const position = Math.floor(progress * TRACK_WIDTH)

	return [
		[`${id}  `, 'bold'],
		[
			`${source} `,
			source === 'QUEUE'
				? STATE_MARKERS.W.style
				: 'dim',
		],
		[
			'─'.repeat(position),
			'dim',
		],
		['◆', STATE_MARKERS['>'].style],
		[`${'─'.repeat(TRACK_WIDTH - position)}→ `, 'dim'],
		['RUN', STATE_MARKERS.R.style],
	]
}

export function renderTimeline({ state, flow, now, step, stepMs, historySteps, columns, rows, isFinal }) {
	const { lanes, getTickerLines } = state
	const showLastEvent = rows >= 7 * lanes.size + 9
	const showDetails = rows >= 5 * lanes.size + 8
	const showTransfer = rows >= 6 * lanes.size + 8
	const showSummary = rows >= 3 * lanes.size + 8
	const keyWidth = Math.max('EVENTS'.length, ...Array.from(lanes.keys(), key => key.length))
	const width = Math.max(1, Math.min(historySteps, columns - keyWidth - 4))
	const first = Math.max(0, step - width + 1)
	const lines = []
	const addLine = (...parts) => lines.push(formatLine(parts, columns - 1))
	const gutter = ' '.repeat(keyWidth + 3)
	const ruler = Array.from({ length: width }, (_, offset) => (first + offset) % 10 === 0
		? '|'
		: '─').join('')
	const labels = []

	for (let offset = 0; offset < width; offset++) {
		const tick = first + offset

		if (tick % 10 === 0)
			labels.push([offset, `+${tick * stepMs / 1000}s`])
	}

	const { active, waiting, capacity, concurrency, completed, dropped, errors, traffic } = flow
	const slotsFull = active >= concurrency
	const maxSlots = concurrency === Infinity
		? '∞'
		: concurrency

	addLine(['TIMELINE', 'bold'], [`   +${now} ms   ·   ${stepMs} ms per cell`, 'dim'], [
		traffic
			? `   ·   ${traffic}`
			: '',
	])

	addLine(
		[
			`SLOTS ${active}/${maxSlots}`,
			slotsFull ? 'yellow' : STATE_MARKERS.R.style,
		],
		['    '],
		[`QUEUE ${waiting}/${capacity}`, STATE_MARKERS.W.style],
		[`    DONE ${completed}    DROP ${dropped}    ERR ${errors}`, 'dim'],
	)

	function addLegend(title, entries) {
		addLine(
			[
				title.padEnd(keyWidth),
				'dim',
			],
			[' │ ', 'dim'],
			...entries.flatMap(([marker, label, style]) => [
				[marker, style],
				[` ${label} `, style],
			]),
		)
	}

	addLegend('STATE', Object.entries(STATE_MARKERS).map(([symbol, cell]) => [symbol, cell.label, cell.style]))

	addLegend('EVENT', Object.entries(EVENT_MARKERS).map(([symbol, entry]) =>
		[
			symbol.toLowerCase(),
			entry.legend,
			entry.style,
		]))

	if (showLastEvent) {
		let marks = ''

		for (const [offset, label] of labels)
			marks = marks.padEnd(offset) + label

		addLine([gutter], [marks, 'dim'])
		addLine([gutter], [ruler, 'dim'])
	}
	else {
		const compactRuler = ruler.split('')

		for (const [offset, label] of labels)
			compactRuler.splice(offset, label.length, ...label)

		addLine([gutter], [
			compactRuler.join('').slice(0, width),
			'dim',
		])
	}

	for (const [key, lane] of lanes) {
		const remaining = lane.remaining
		const history = []
		const events = []

		for (let cell = first; cell <= step; cell++) {
			const symbol = lane.history.get(cell) ?? ' '
			const event = lane.events.get(cell)
			history.push([symbol, STATE_MARKERS[symbol]?.style])

			events.push(event
				? [
						event.marker.toLowerCase(),
						event.style,
					]
				: ['·', 'dim'])
		}

		const nextAt = Math.min(...Array.from(lane.upcoming, task => task.atMs))
		const arrival = Number.isFinite(nextAt)
			? ` | next arrival in ${Math.max(0, nextAt - now)} ms`
			: ''
		const resume = lane.resumedAt === undefined
			? ''
			: ` | resumed +${lane.resumedAt} ms`
		const quota = remaining ?? (lane.needsProbe
			? 'probe needed'
			: 'ready')

		addLine(
			[
				key.padEnd(keyWidth),
				'bold',
			],
			[' │ ', 'dim'],
			...history,
		)

		addLine([
			'EVENTS'.padEnd(keyWidth),
			'dim',
		], [' │ ', 'dim'], ...events)

		if (!showDetails) {
			if (showSummary) {
				addLine(
					[`  QUEUE ${lane.waiting.size}  `, STATE_MARKERS.W.style],
					[`RUN ${lane.running.size}  `, STATE_MARKERS.R.style],
					[`QUOTA ${quota}`, STATE_MARKERS.Q.style],
				)
			}

			continue
		}

		addLine(
			[`  QUEUE ${String(lane.waiting.size).padStart(2)} │ `, STATE_MARKERS.W.style],
			[[...lane.waiting].join(', ') || '—'],
		)

		const waitsForSlot = lane.waiting.size > 0 && remaining === undefined && slotsFull

		addLine(
			['  QUOTA    │ ', STATE_MARKERS.Q.style],
			[
				quota,
				remaining === undefined
					? 'dim'
					: STATE_MARKERS.Q.style,
			],
			[
				waitsForSlot ? '   · waiting for a slot' : '',
				'yellow',
			],
		)

		addLine(
			[`  RUN   ${String(lane.running.size).padStart(2)} │ `, STATE_MARKERS.R.style],
			[[...lane.running].join(', ') || '—'],
			...(!showTransfer && lane.transfer
				? [
						['   MOVE ', 'dim'],
						...getTransferParts(lane.transfer, now, isFinal),
					]
				: []),
		)

		if (showTransfer)
			addLine(['  MOVE     │ ', 'dim'], ...getTransferParts(lane.transfer, now, isFinal))

		if (showLastEvent)
			addLine(['  LAST     │ ', 'dim'], [lane.lastEvent || 'idle', lane.eventStyle], [arrival, 'dim'], [resume, STATE_MARKERS['>'].style])
	}

	const tickerRows = getTickerLines(columns - 1)
	lines.splice(2, 0, ...tickerRows.map(parts => formatLine(parts, columns - 1)))

	return lines
}
