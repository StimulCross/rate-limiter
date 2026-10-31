import { FixedWindowLimiter } from '@stimulcross/rate-limiter/fixed-window'
import { scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { repeatFlow } from './workload.js'

const options = {
	limitOptions: {
		limit: 3,
		windowMs: scaleMs(1000),
	},
	limitBehavior: 'enqueue',
	queue: { capacity: 1, concurrency: 1 },
}

printScenario('1/1', 'One shared waiting place', 'One execution slot and one waiting place shared by all keys. Each wave opens with a task that takes 1100 ms.')

await runFlow(FixedWindowLimiter, options, repeatFlow([
	{
		id: 'long-job',
		key: 'A',
		atMs: 0,
		workMs: 1100,
	},
	{
		id: 'cancel',
		key: 'B',
		atMs: 100,
		workMs: 250,
		abortAfterMs: 250,
	},
	{
		id: 'overflow',
		key: 'C',
		atMs: 200,
		workMs: 250,
	},
	{
		id: 'expire',
		key: 'C',
		atMs: 450,
		workMs: 250,
		maxWaitMs: 250,
	},
	{
		id: 'next',
		key: 'B',
		atMs: 800,
		workMs: 300,
	},
], [0, 1800, 3600]))
