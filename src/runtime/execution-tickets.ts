import { Deque } from '@stimulcross/ds-deque';

/** @internal */
export class ExecutionTickets {
	private readonly _tickets = new Deque<number>();

	public get size(): number {
		return this._tickets.size;
	}

	public get isEmpty(): boolean {
		return this._tickets.size === 0;
	}

	public add(tick: number): void {
		this._tickets.push(tick);
	}

	public peek(): number | undefined {
		return this._tickets.peekHead();
	}

	public consume(): number | undefined {
		return this._tickets.shift();
	}

	public dropLast(): number | undefined {
		return this._tickets.pop();
	}

	public clear(): void {
		this._tickets.clear();
	}
}
