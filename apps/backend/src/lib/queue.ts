/**
 * Simple in-memory semaphore for limiting concurrency.
 * Used to cap the number of parallel Claude CLI invocations.
 */

type Resolver = (release: () => void) => void;

export class Semaphore {
  private readonly maxConcurrency: number;
  private _active = 0;
  private readonly waiters: Resolver[] = [];

  constructor(maxConcurrency: number) {
    if (maxConcurrency < 1) {
      throw new Error(`Semaphore maxConcurrency must be >= 1, got ${maxConcurrency}`);
    }
    this.maxConcurrency = maxConcurrency;
  }

  /** Number of callers currently waiting to acquire the semaphore. */
  get pending(): number {
    return this.waiters.length;
  }

  /** Number of callers currently holding the semaphore. */
  get active(): number {
    return this._active;
  }

  /**
   * Acquire a slot. Resolves immediately if a slot is available,
   * otherwise waits until one is freed.
   * @returns A release function - call it exactly once when done.
   */
  async acquire(): Promise<() => void> {
    if (this._active < this.maxConcurrency) {
      this._active++;
      return this.createRelease();
    }

    // No slot available - enqueue and wait
    return new Promise<() => void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      this._active--;
      this.dispatch();
    };
  }

  private dispatch(): void {
    if (this.waiters.length > 0 && this._active < this.maxConcurrency) {
      const next = this.waiters.shift()!;
      this._active++;
      next(this.createRelease());
    }
  }
}
