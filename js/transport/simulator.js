import { ByteTransport } from './base.js';
import { checksum, now } from '../util.js';

/**
 * A fake K-line bus with a simulated engine ECU (modelled on an early-2000s Siemens unit).
 * It works at the byte level — echo, 5-baud/fast init, timing, checksums — so the whole
 * protocol stack gets exercised without a car.
 */
export class SimulatorTransport extends ByteTransport {
  constructor({ protocol = 'iso9141' } = {}) {
    super();
    this.protocol = protocol;
  }

  static supported() {
    return true;
  }

  get name() {
    return `Simulated ECU (${this.protocol === 'iso9141' ? 'ISO 9141-2' : 'KWP2000'})`;
  }

  async open() {
    this.ecu = new SimEcu(this.protocol, (b) => this._push(b));
  }

  async setBreak(on) {
    // A real cable reads back garbage while the line is held low.
    if (on) setTimeout(() => this._push([0x00]), 4);
    this.ecu.line(on);
  }

  async setLines() {}

  async write(bytes) {
    const b = Uint8Array.from(bytes);
    setTimeout(() => this._push(b), 1); // K-line echo
    this.ecu.rx(b);
  }

  async close() {
    this.ecu?.stop();
  }
}

const SUPPORTED = [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x13, 0x14, 0x15, 0x1c, 0x1f, 0x21];
const u8 = (x) => Math.max(0, Math.min(255, Math.round(x)));
const u16 = (x) => {
  const v = Math.max(0, Math.min(65535, Math.round(x)));
  return [v >> 8, v & 0xff];
};
const dtcBytes = (code) => [code >> 8, code & 0xff];

class SimEcu {
  constructor(protocol, send) {
    this.kwp = protocol !== 'iso9141';
    this.sendRaw = send;
    this.state = 'idle';
    this.edges = [];
    this.rxBuf = [];
    this.t0 = now();
    this.stored = [0x0171, 0x0420]; // P0171 lean, P0420 catalyst
    this.pending = [0x0300]; // P0300 random misfire
    this.cleared = false;
    this.freeze = { dtc: 0x0171, 0x04: [u8(22 * 2.55)], 0x05: [88 + 40], 0x06: [u8(128 + 18 * 1.28)], 0x0c: u16(2450 * 4), 0x0d: [72], 0x0b: [41] };
    this.timers = new Set();
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.decodeTimer);
    clearTimeout(this.frameTimer);
  }

  send(bytes, delay) {
    const t = setTimeout(() => { this.timers.delete(t); this.sendRaw(Uint8Array.from(bytes)); }, delay);
    this.timers.add(t);
  }

  // ---- init detection -------------------------------------------------------------
  line(low) {
    const t = now();
    this.edges.push({ t, low });
    clearTimeout(this.decodeTimer);
    if (low) return;
    const lastLow = [...this.edges].reverse().find((e) => e.low);
    if (!lastLow) { this.edges = []; return; }
    const lowDur = t - lastLow.t;
    if (lowDur > 15 && lowDur < 40) {
      // 25 ms wake-up pulse = KWP fast init (5-baud bits are 200 ms long)
      this.edges = [];
      this.state = this.kwp ? 'fastWait' : 'idle';
      return;
    }
    this.decodeTimer = setTimeout(() => this.#decode5Baud(), 450);
  }

  #decode5Baud() {
    const e = this.edges;
    this.edges = [];
    const first = e.find((x) => x.low);
    if (!first) return;
    const levelLow = (tt) => {
      let low = false;
      for (const x of e) if (x.t <= tt) low = x.low;
      return low;
    };
    let addr = 0;
    for (let i = 0; i < 8; i++) if (!levelLow(first.t + 200 * (i + 1) + 100)) addr |= 1 << i;
    if (addr !== 0x33) return;
    this.kb = this.kwp ? [0xe9, 0x8f] : [0x08, 0x08];
    this.state = 'kbWait';
    this.send([0x55], 40);
    this.send([this.kb[0]], 46);
    this.send([this.kb[1]], 52);
  }

  // ---- frames --------------------------------------------------------------------
  rx(bytes) {
    for (const b of bytes) {
      if (this.state === 'kbWait') {
        if (b === (~this.kb[1] & 0xff)) {
          this.state = 'session';
          this.lastMsg = now();
          this.send([0xcc], 30);
        }
        continue;
      }
      this.rxBuf.push(b);
    }
    clearTimeout(this.frameTimer);
    this.frameTimer = setTimeout(() => this.#onFrame(), 25);
  }

  #onFrame() {
    const f = this.rxBuf;
    this.rxBuf = [];
    if (f.length < 4 || checksum(f.slice(0, -1)) !== f[f.length - 1]) return;
    const data = f.slice(3, -1);
    if (this.state === 'fastWait') {
      if (data[0] === 0x81) {
        this.state = 'session';
        this.lastMsg = now();
        this.reply([[0xc1, 0xe9, 0x8f]]);
      }
      return;
    }
    if (this.state !== 'session') return;
    if (now() - this.lastMsg > 5000) { this.state = 'idle'; return; } // P3max timeout
    this.lastMsg = now();
    this.reply(this.handle(data));
  }

  reply(msgs) {
    msgs.forEach((d, i) => {
      const hdr = this.kwp ? [0x80 | d.length, 0xf1, 0x10] : [0x48, 0x6b, 0x10];
      const f = [...hdr, ...d];
      f.push(checksum(f));
      this.send(f, 30 + i * 35);
    });
  }

  // ---- services ------------------------------------------------------------------
  handle(d) {
    const [sid, pid] = d;
    switch (sid) {
      case 0x01: {
        const v = this.pidValue(pid);
        return v ? [[0x41, pid, ...v]] : this.kwp ? [[0x7f, 0x01, 0x12]] : [];
      }
      case 0x02: {
        if (!this.freeze) return [[0x7f, 0x02, 0x12]];
        if (pid === 0x00) return [[0x42, 0x00, 0x00, ...this.mask(Object.keys(this.freeze).filter((k) => k !== 'dtc').map(Number).concat(0x02), 0)]];
        if (pid === 0x02) return [[0x42, 0x02, 0x00, ...dtcBytes(this.freeze.dtc)]];
        const v = this.freeze[pid];
        return v ? [[0x42, pid, 0x00, ...v]] : [[0x7f, 0x02, 0x12]];
      }
      case 0x03:
      case 0x07:
        return this.dtcFrames(sid + 0x40, sid === 0x03 ? this.stored : this.pending);
      case 0x04:
        this.stored = [];
        this.pending = [];
        this.freeze = null;
        this.cleared = true;
        return [[0x44]];
      case 0x09:
        if (pid === 0x00) return [[0x49, 0x00, 0x01, 0x40, 0x00, 0x00, 0x00]];
        if (pid === 0x02) {
          const vin = [0, 0, 0, ...Array.from('SIMULATED0VIN0001', (c) => c.charCodeAt(0))];
          return [0, 1, 2, 3, 4].map((i) => [0x49, 0x02, i + 1, ...vin.slice(i * 4, i * 4 + 4)]);
        }
        return [[0x7f, 0x09, 0x12]];
      default:
        return [[0x7f, sid, 0x11]];
    }
  }

  dtcFrames(sid, list) {
    const codes = [...list];
    const frames = [];
    do {
      const chunk = codes.splice(0, 3);
      while (chunk.length < 3) chunk.push(0);
      frames.push([sid, ...chunk.flatMap(dtcBytes)]);
    } while (codes.length);
    return frames;
  }

  mask(list, base) {
    const out = [0, 0, 0, 0];
    for (const p of list) {
      const i = p - base - 1;
      if (i >= 0 && i < 32) out[i >> 3] |= 0x80 >> (i & 7);
    }
    return out;
  }

  pidValue(pid) {
    if (pid === 0x00 || pid === 0x20 || pid === 0x40) {
      if (pid > 0 && !SUPPORTED.some((p) => p > pid)) return null;
      const list = [...SUPPORTED];
      if (SUPPORTED.some((p) => p > pid + 0x20)) list.push(pid + 0x20);
      return this.mask(list, pid);
    }
    if (!SUPPORTED.includes(pid)) return null;

    const t = (now() - this.t0) / 1000;
    const cyc = t % 20; // a blip of the throttle every 20 s
    const rev = cyc > 12 && cyc < 16 ? Math.sin(((cyc - 12) / 4) * Math.PI) : 0;
    const rpm = 830 + 25 * Math.sin(t * 2.1) + rev * 5000;
    const throttle = 1.6 + rev * 88;
    const map = 33 + 2 * Math.sin(t * 1.3) + rev * 128; // up to ~160 kPa abs ≈ 8.5 psi boost
    const coolant = Math.min(89, 22 + t * 1.5);
    const stft = 2 * Math.sin(t * 3.7) + (Math.random() - 0.5) * 2;
    const o2 = 0.45 + 0.4 * Math.sin(t * 6);
    const mil = this.stored.length ? 0x80 : 0;
    const inc = this.cleared ? 0x65 : 0x00;

    switch (pid) {
      case 0x01: return [mil | this.stored.length, this.cleared ? 0x77 : 0x07, 0x65, inc];
      case 0x03: return [coolant < 40 ? 0x01 : rev > 0.6 ? 0x04 : 0x02, 0x00];
      case 0x04: return [u8((18 + rev * 70) * 2.55)];
      case 0x05: return [u8(coolant + 40)];
      case 0x06: return [u8(128 + stft * 1.28)];
      case 0x07: return [u8(128 + 4.7 * 1.28)];
      case 0x0b: return [u8(map)];
      case 0x0c: return u16(rpm * 4);
      case 0x0d: return [0];
      case 0x0e: return [u8((12 + rev * 18 + Math.sin(t) * 2 + 64) * 2)];
      case 0x0f: return [u8(24 + rev * 12 + 40)];
      case 0x11: return [u8(throttle * 2.55)];
      case 0x13: return [0x03];
      case 0x14: return [u8(o2 * 200), u8(128 + stft * 1.28)];
      case 0x15: return [u8(0.71 * 200), 0xff];
      case 0x1c: return [0x01];
      case 0x1f: return u16(t);
      case 0x21: return u16(this.stored.length ? 37 : 0);
      default: return null;
    }
  }
}
