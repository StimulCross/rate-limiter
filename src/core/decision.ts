/** @internal */
export type DecisionKind = 'allow' | 'deny' | 'delay';

/** @internal */
export interface DecisionBase {
	kind: DecisionKind;
}

/** @internal */
export interface DecisionAllow extends DecisionBase {
	kind: Extract<DecisionKind, 'allow'>;
}

/** @internal */
export interface DecisionDeny extends DecisionBase {
	kind: Extract<DecisionKind, 'deny'>;
	retryAt: number;
}

/** @internal */
export interface DecisionDelay extends DecisionBase {
	kind: Extract<DecisionKind, 'delay'>;
	runAt: number;
}

/** @internal */
export type Decision = DecisionAllow | DecisionDeny | DecisionDelay;
