import { env, stdout } from 'node:process'
import { styleText } from 'node:util'
import { getSlowdown, pauseMs } from '../pacing.js'

let forceDashboard = false
const terminalHasColor = stdout.isTTY && env.TERM !== 'dumb' && stdout.hasColors()

export function enableDashboard() {
	forceDashboard = true
}

export function isDashboardEnabled() {
	return forceDashboard || stdout.isTTY
}

export function paint(style, text) {
	return env.NO_COLOR === undefined && (forceDashboard || terminalHasColor) && style && text
		? styleText(style, text, { validateStream: false })
		: text
}

function paintBorder(text) {
	return paint('blue', text)
}

function wrap(text, width) {
	const lines = []
	let line = ''

	for (const word of text.replaceAll(/(\d) (ms|s)\b/g, '$1\u00A0$2').split(' ')) {
		if (line && line.length + word.length + 1 > width) {
			lines.push(line)
			line = ''
		}

		line = line
			? `${line} ${word}`
			: word
	}

	if (line)
		lines.push(line)

	return lines
}

export function printScenario(part, title, description) {
	const timing = `Playback ${getSlowdown()}× durations · Hold ${pauseMs} ms · Baseline timings above`
	const width = Math.min(84, (stdout.columns || 80) - 1)

	if (!isDashboardEnabled() || width < 32) {
		console.log(`\nScenario ${part} · ${title}\nWatch for ${description}\n${timing}\n`)

		return
	}

	const contentWidth = width - 4
	const header = `─ SCENARIO ${part} `
	const rows = [
		paintBorder(`╭${header.padEnd(width - 2, '─')}╮`),
	]

	const row = (text, style) => {
		rows.push(`${paintBorder('│')} ${paint(style, text)}${' '.repeat(contentWidth - text.length)} ${paintBorder('│')}`)
	}

	for (const line of wrap(title, contentWidth))
		row(line, ['bold', 'cyan'])

	row('')
	row('WATCH FOR', ['bold', 'yellow'])

	for (const line of wrap(description, contentWidth))
		row(line)

	row('')

	for (const line of wrap(timing, contentWidth))
		row(line, 'dim')

	rows.push(paintBorder(`╰${'─'.repeat(width - 2)}╯`))
	console.log(`\n${rows.join('\n')}\n`)
}
