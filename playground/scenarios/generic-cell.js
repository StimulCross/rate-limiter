import { GenericCellLimiter } from '@stimulcross/rate-limiter/generic-cell'
import { scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createBurst, repeatFlow } from './workload.js'

const options = {
	limitOptions: {
		burst: 3,
		intervalMs: scaleMs(350),
	},
	limitBehavior: 'enqueue',
	queue: {
		capacity: 7,
		concurrency: 3,
		maxWaitMs: scaleMs(5000),
	},
}
const tasks = repeatFlow(createBurst('event', 9, 100, 200), [0, 3500])

printScenario('1/2', 'Initial burst followed by paced starts', 'Up to three starts can fit into the burst, then new starts follow the 350 ms interval.')
await runFlow(GenericCellLimiter, options, tasks)

printScenario('2/2', 'Burst set to one', 'The same key can only start once per 230 ms. Closely spaced arrivals wait from the second task onward.')

await runFlow(GenericCellLimiter, {
	limitOptions: {
		burst: 1,
		intervalMs: scaleMs(230),
	},
	limitBehavior: 'enqueue',
	queue: { capacity: 5 },
}, repeatFlow(createBurst('event', 6, 80, 140), [0, 1900, 3800]))
