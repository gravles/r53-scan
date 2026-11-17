import { now } from '../util.js';

/**
 * Common receive buffer for all transports. Subclasses call _push() with incoming bytes
 * and implement open/close/write/setBreak/setLines.
 */
export class ByteTransport {
  constructor() {
    this._buf = [];
    this._waiters = [];
    this.onError = null;
  }

  _push(bytes) {
    for (const b of bytes) this._buf.push(b);
    const w = this._waiters;
    this._waiters = [];
    for (const f of w) f();
  }

  _waitData(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve(false); }
      }, Math.max(0, timeoutMs));
      this._waiters.push(() => {
        if (!done) { done = true; clearTimeout(timer); resolve(true); }
      });
    });
  }

  flushInput() {
    this._buf.length = 0;
  }

  /** Read up to n bytes, waiting at most timeoutMs for them to arrive. */
  async readExact(n, timeoutMs) {
    const end = now() + timeoutMs;
    while (this._buf.length < n) {
      const left = end - now();
      if (left <= 0) break;
      await this._waitData(left);
    }
    return Uint8Array.from(this._buf.splice(0, Math.min(n, this._buf.length)));
  }

  /**
   * Wait up to firstMs for data to start, then keep collecting until the line has been
   * quiet for idleMs (K-line ISO 9141 frames carry no length, so silence ends a reply).
   */
  async readUntilIdle(firstMs, idleMs, maxMs) {
    const start = now();
    if (!this._buf.length) {
      await this._waitData(firstMs);
      if (!this._buf.length) return new Uint8Array(0);
    }
    while (now() - start < maxMs) {
      const more = await this._waitData(idleMs);
      if (!more) break;
    }
    return Uint8Array.from(this._buf.splice(0));
  }
}
