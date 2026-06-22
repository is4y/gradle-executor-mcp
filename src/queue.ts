export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // keep the chain alive regardless of success/failure, without leaking rejections
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
