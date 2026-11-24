// One active long-running operation per caller-owned workspace session.
import { randomUUID } from 'node:crypto';

type Operation = {
  id: string;
  tool: string;
  state: 'running' | 'succeeded' | 'failed';
  result?: unknown;
  error?: string;
};

export class WorkspaceOperations {
  private readonly history = new Map<string, Operation>();

  start(tool: string, run: () => Promise<unknown>) {
    const previous = [...this.history.values()];
    const active = previous.find(op => op.state === 'running');
    if (active) throw new Error('Operation ' + active.id + ' is already running. Read operation_status before starting another.');
    if (previous.length >= 12) this.history.delete(previous[0]!.id);
    const operation: Operation = { id: randomUUID(), tool, state: 'running' };
    this.history.set(operation.id, operation);
    void run().then(result => {
      operation.result = result;
      operation.state = 'succeeded';
    }, err => {
      operation.error = err instanceof Error ? err.message : String(err);
      operation.state = 'failed';
    });
    return { ...operation };
  }

  status(id?: string) {
    if (!id) return { operations: [...this.history.values()].map(({ id, tool, state }) => ({ id, tool, state })) };
    const operation = this.history.get(id);
    if (!operation) throw new Error('Unknown operation in this session.');
    return { ...operation };
  }
}
