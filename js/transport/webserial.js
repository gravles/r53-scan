import { ByteTransport } from './base.js';

/**
 * Desktop Chrome/Edge: talks to the cable's FTDI chip through the OS serial driver.
 * K-line init patterns are produced with the serial BREAK signal (holds TX low).
 */
export class WebSerialTransport extends ByteTransport {
  static supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  get name() {
    const i = this.port?.getInfo?.() ?? {};
    return i.usbVendorId === 0x0403 ? 'FTDI USB serial (Web Serial)' : 'Serial port (Web Serial)';
  }

  async open({ baud = 10400, dtr = false, rts = false } = {}) {
    // Show every port: some clones report a non-FTDI vendor id.
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
    await this.port.setSignals({ dataTerminalReady: dtr, requestToSend: rts, break: false });
    this._closing = false;
    this._readLoop = this.#readLoop();
  }

  async #readLoop() {
    let errors = 0;
    while (this.port && !this._closing) {
      // After a non-fatal error Chrome swaps in a new stream; give it a moment if it isn't there yet.
      if (!this.port.readable) {
        await new Promise((r) => setTimeout(r, 20));
        if (!this.port?.readable && !this._closing) {
          this.onError?.(new Error('Serial port stopped delivering data (readable stream gone)'));
          return;
        }
        continue;
      }
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) this._push(value);
        }
      } catch (e) {
        // BREAK on the K-line shows up as framing/break errors. They are non-fatal:
        // the stream is recreated and we just grab a new reader.
        if (!['BreakError', 'FramingError', 'ParityError', 'BufferOverrunError'].includes(e.name)) {
          if (!this._closing) this.onError?.(e);
        } else if (++errors <= 3) {
          this.onNote?.(`Serial read: ${e.name} (normal during wake-up)`);
        }
      } finally {
        this.reader.releaseLock();
      }
    }
  }

  async setBreak(on) {
    await this.port.setSignals({ break: on });
  }

  async setLines(dtr, rts) {
    await this.port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
  }

  async write(bytes) {
    const w = this.port.writable.getWriter();
    try {
      await w.write(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    } finally {
      w.releaseLock();
    }
  }

  async close() {
    this._closing = true;
    try { await this.reader?.cancel(); } catch {}
    try { await this._readLoop; } catch {}
    try { await this.port?.close(); } catch {}
    this.port = null;
  }
}
