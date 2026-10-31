import process from 'node:process'
import { parseArgs } from 'node:util'
import { configureStreamSlowdown, DEFAULT_STREAM_SLOWDOWN } from './pacing.js'
import { enableDashboard, paint } from './terminal/presentation.js'

const scenarios = {
	'fixed-window': 'Independent keys with short and long quota windows',
	'token-bucket': 'An initial burst and fractional refill',
	'sliding-window-log': 'Capacity returns as individual starts expire',
	'sliding-window-counter': 'The previous window loses weight until a start fits',
	'generic-cell': 'An initial burst followed by a queued start',
	'leaky-bucket': 'A minimum gap between actual starts',
	'http-response-based': 'A probe funds a follower and HTTP 429 triggers cooldown',
	'queue': 'Shared capacity, cancellation, expiry and slot release',
	'priority': 'Weighted selection across two keys',
}
const requested = process.argv.slice(2)

async function selectStream(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			slowdown: { type: 'string' },
			dashboard: { type: 'boolean' },
			list: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
	})

	if (values.help) {
		console.log(`Usage: pnpm playground:stream [limiter] [--slowdown N] [--dashboard]
       pnpm playground:stream --list

Default limiter: token-bucket
Default slowdown: ${DEFAULT_STREAM_SLOWDOWN}× durations. Use 1 for baseline speed, or a larger integer for a slower stream.
PLAYGROUND_SLOWDOWN sets the default when --slowdown is omitted.
Use + and - to speed up or slow down arrivals. Space pauses or resumes them.
Use --dashboard to force ANSI output in a compatible console.
Press Ctrl+C to stop.`)

		return
	}

	const { streamNames } = await import('./stream/stream-limiters.js')
	const [name = 'token-bucket'] = positionals

	if (values.list) {
		console.log(streamNames.join('\n'))

		return
	}

	if (positionals.length > 1 || !streamNames.includes(name))
		throw new Error('Choose one limiter. Run pnpm playground:stream --list for the available limiters.')

	configureStreamSlowdown(values.slowdown)

	if (values.dashboard)
		enableDashboard()

	return name
}

if (requested[0] === 'stream') {
	const name = await selectStream(requested.slice(1)).catch(err => {
		console.error(err.message)
		process.exitCode = 1
	})

	if (name) {
		const { runRandomStream } = await import('./stream/random-stream.js')
		await runRandomStream(name)
	}
}
else if (requested.length === 1 && requested[0] === '--list') {
	for (const [name, description] of Object.entries(scenarios))
		console.log(`${name.padEnd(24)} ${description}`)

	console.log('pnpm playground:stream              Continuous randomized traffic until Ctrl+C')
}
else if (requested.some(name => !Object.hasOwn(scenarios, name))) {
	console.error('Unknown scenario. Pass --list to see the available scenarios.')
	process.exitCode = 1
}
else {
	const selected = requested.length > 0
		? new Set(requested)
		: Object.keys(scenarios)

	for (const name of selected) {
		console.log(`\n${paint('bold', name)}`)
		await import(`./scenarios/${name}.js`)
	}
}
