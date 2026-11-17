import { ByteTransport } from './base.js';
import { sleep } from '../util.js';

// FTDI vendor requests (same values libftdi / Linux ftdi_sio use)
const REQ_RESET = 0x00;
const REQ_MODEM_CTRL = 0x01;
const REQ_FLOW_CTRL = 0x02;
const REQ_BAUD = 0x03;
const REQ_DATA = 0x04;
const REQ_LATENCY = 0x09;
const DATA_8N1 = 0x0008;
const DATA_BREAK = 0x4000;

/** FT232R baud divisor: 3 MHz base clock with 1/8 fractional steps. */
export function ftdiDivisor(baud) {
  const FRAC = [0, 3, 2, 4, 1, 5, 6, 7]; // encoding for 0, 1/8, 2/8 ... 7/8
  const eighths = Math.round((3000000 * 8) / baud);
  const int = eighths >> 3;
  const code = FRAC[eighths & 7];
  const div = int | (code << 14);
  return { value: div & 0xffff, index: div >> 16 };
}

/**
 * Android Chrome (USB OTG): drives the cable's FT232RL chip directly over WebUSB,
 * since Android has no serial driver for web pages. Also sets the 1 ms latency timer,
 * which makes K-line timing much tighter than the 16 ms default.
 */
export class WebUsbFtdiTransport extends ByteTransport {
  static supported() {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }

  get name() {
    return `${this.dev?.productName || 'FTDI'} (WebUSB)`;
  }

  async open({ baud = 10400, dtr = false, rts = false, latency = 1 } = {}) {
    this.dev = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0403 }] });
    await this.dev.open();
    if (!this.dev.configuration) await this.dev.selectConfiguration(1);
    await this.dev.claimInterface(0);
    const eps = this.dev.configuration.interfaces[0].alternate.endpoints;
    const epIn = eps.find((e) => e.direction === 'in');
    const epOut = eps.find((e) => e.direction === 'out');
    this.epIn = epIn.endpointNumber;
    this.epOut = epOut.endpointNumber;
    this.pkt = epIn.packetSize || 64;

    await this.#ctrl(REQ_RESET, 0); // reset
    await this.#ctrl(REQ_RESET, 1); // purge RX
    await this.#ctrl(REQ_RESET, 2); // purge TX
    await this.#ctrl(REQ_FLOW_CTRL, 0);
    await this.#ctrl(REQ_DATA, DATA_8N1);
    const d = ftdiDivisor(baud);
    await this.#ctrl(REQ_BAUD, d.value, d.index);
    await this.#ctrl(REQ_LATENCY, latency);
    await this.setLines(dtr, rts);
    this._run = true;
    this._readLoop = this.#readLoop();
  }

  #ctrl(request, value, index = 0) {
    return this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index });
  }

  async #readLoop() {
    while (this._run) {
      try {
        const r = await this.dev.transferIn(this.epIn, this.pkt * 8);
        if (r.status === 'stall') { await this.dev.clearHalt('in', this.epIn); continue; }
        const u = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        // Every USB packet starts with 2 FTDI modem-status bytes; strip them.
        const out = [];
        for (let i = 0; i < u.length; i += this.pkt) {
          const end = Math.min(i + this.pkt, u.length);
          for (let j = i + 2; j < end; j++) out.push(u[j]);
        }
        if (out.length) this._push(out);
      } catch (e) {
        if (!this._run) break;
        this.onError?.(e);
        await sleep(100);
      }
    }
  }

  async setBreak(on) {
    await this.#ctrl(REQ_DATA, DATA_8N1 | (on ? DATA_BREAK : 0));
  }

  async setLines(dtr, rts) {
    await this.#ctrl(REQ_MODEM_CTRL, dtr ? 0x0101 : 0x0100);
    await this.#ctrl(REQ_MODEM_CTRL, rts ? 0x0202 : 0x0200);
  }

  async write(bytes) {
    await this.dev.transferOut(this.epOut, bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  async close() {
    this._run = false;
    try { await this.dev?.releaseInterface(0); } catch {}
    try { await this.dev?.close(); } catch {}
    this.dev = null;
  }
}
