import type { Priority } from './priority.js'

/**
 * Positive finite selection weights for all five priority classes.
 *
 * The weights determine each offered class's share of callback starts.
 */
export type PriorityWeights = Readonly<Record<Priority, number>>
