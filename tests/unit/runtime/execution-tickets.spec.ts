import { describe, expect, it } from 'vitest';
import { ExecutionTickets } from '../../../src/runtime/execution-tickets.js';

describe('ExecutionTickets', () => {
	describe('State', () => {
		it('should start empty', () => {
			const tickets = new ExecutionTickets();

			expect(tickets.size).toBe(0);
			expect(tickets.isEmpty).toBe(true);
			expect(tickets.peek()).toBeUndefined();
			expect(tickets.consume()).toBeUndefined();
			expect(tickets.dropLast()).toBeUndefined();
		});

		it('should update size and isEmpty after add and consume', () => {
			const tickets = new ExecutionTickets();

			tickets.add(10);
			expect(tickets.isEmpty).toBe(false);
			expect(tickets.size).toBe(1);

			const consumed = tickets.consume();
			expect(consumed).toBe(10);
			expect(tickets.size).toBe(0);
			expect(tickets.isEmpty).toBe(true);
		});
	});

	describe('FIFO behavior', () => {
		it('should peek next without consuming', () => {
			const tickets = new ExecutionTickets();

			tickets.add(1);
			tickets.add(2);

			expect(tickets.peek()).toBe(1);
			expect(tickets.size).toBe(2);
			expect(tickets.peek()).toBe(1);
		});

		it('should consume in FIFO order', () => {
			const tickets = new ExecutionTickets();

			tickets.add(5);
			tickets.add(6);
			tickets.add(7);

			expect(tickets.consume()).toBe(5);
			expect(tickets.consume()).toBe(6);
			expect(tickets.consume()).toBe(7);
			expect(tickets.consume()).toBeUndefined();

			expect(tickets.size).toBe(0);
			expect(tickets.isEmpty).toBe(true);
		});
	});

	describe('LIFO behavior', () => {
		it('should drop last in LIFO order from the end', () => {
			const tickets = new ExecutionTickets();

			tickets.add(1);
			tickets.add(2);
			tickets.add(3);

			expect(tickets.dropLast()).toBe(3);
			expect(tickets.size).toBe(2);

			expect(tickets.peek()).toBe(1);
			expect(tickets.consume()).toBe(1);
			expect(tickets.consume()).toBe(2);
			expect(tickets.consume()).toBeUndefined();
		});

		it('should return undefined when dropping from empty', () => {
			const tickets = new ExecutionTickets();

			expect(tickets.dropLast()).toBeUndefined();
			expect(tickets.size).toBe(0);
			expect(tickets.isEmpty).toBe(true);
		});
	});

	describe('Clear', () => {
		it('should remove all tickets and reset state', () => {
			const tickets = new ExecutionTickets();

			tickets.add(100);
			tickets.add(200);

			expect(tickets.size).toBe(2);
			expect(tickets.isEmpty).toBe(false);

			tickets.clear();

			expect(tickets.size).toBe(0);
			expect(tickets.isEmpty).toBe(true);
			expect(tickets.peek()).toBeUndefined();
			expect(tickets.consume()).toBeUndefined();
			expect(tickets.dropLast()).toBeUndefined();
		});

		it('should be safe to clear multiple times', () => {
			const tickets = new ExecutionTickets();

			tickets.clear();
			tickets.clear();

			expect(tickets.size).toBe(0);
			expect(tickets.isEmpty).toBe(true);

			tickets.add(1);
			expect(tickets.size).toBe(1);

			tickets.clear();
			expect(tickets.size).toBe(0);
			expect(tickets.isEmpty).toBe(true);
		});
	});
});
