export class SessionOperationQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.queues.set(sessionId, queued);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(sessionId) === queued) {
        this.queues.delete(sessionId);
      }
    }
  }

  size(): number {
    return this.queues.size;
  }
}
