/**
 * Selects how quota-ready tasks compete across keys within one limiter.
 *
 * `weighted` shares starts according to class weights and protects the oldest
 * waiter on each key from repeated bypasses. This is the default.
 *
 * `strict` starts the earliest submitted ready task in the highest ready class.
 * Sustained higher-priority work can postpone lower priorities indefinitely.
 * Supplying defined weights in this mode throws a `RangeError` at construction.
 */
export type PriorityMode = 'weighted' | 'strict'
