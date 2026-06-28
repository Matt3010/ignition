import { SessionOperationQueue } from "../../src/application/services/session-operation-queue.js";

describe("SessionOperationQueue", () => {
  it("serializes operations for the same session and cleans up after completion", async () => {
    const queue = new SessionOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("session-a", async () => {
      events.push("first:start");
      await firstCanFinish;
      events.push("first:end");
      return "first";
    });
    const second = queue.run("session-a", async () => {
      events.push("second:start");
      return "second";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(queue.size()).toBe(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(queue.size()).toBe(0);
  });

  it("does not block different sessions", async () => {
    const queue = new SessionOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("session-a", async () => {
      events.push("first:start");
      await firstCanFinish;
      return "first";
    });
    const second = queue.run("session-b", async () => {
      events.push("second:start");
      return "second";
    });

    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "second:start"]);

    releaseFirst();
    await expect(first).resolves.toBe("first");
    expect(queue.size()).toBe(0);
  });

  it("continues after a failed operation", async () => {
    const queue = new SessionOperationQueue();
    const first = queue.run("session-a", async () => {
      throw new Error("boom");
    });
    const second = queue.run("session-a", async () => "second");

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("second");
    expect(queue.size()).toBe(0);
  });
});
