import { sleep, sleepUntil, now, hex, checksum, Mutex } from './util.js';

export const PROTOCOLS = {
  iso9141: 'ISO 9141-2',
  kwp_slow: 'KWP2000 (5-baud init)',
  kwp_fast: 'KWP2000 (fast init)',
};

export class KLineError extends Error {}

/**
 * OBD-II over the K-line (pin 7): ISO 9141-2 and ISO 14230-4 (KWP2000).
 * Handles wake-up, framing, checksums, the cable's echo of everything we send,
 * reply collection and keep-alive so the ECU doesn't drop the session after 5 s.
 */
export class KLine {
  constructor(transport, opts = {}) {
    this.t = transport;
    this.opts = { interByteMs: 5, idleMs: 60, p2MaxMs: 300, p3Ms: 60, keepAliveMs: 2000, ...opts };
    this.log = opts.log || (() => {});
    this.mutex = new Mutex();
    this.proto = null;
    this.keyBytes = null;
    this.lastRx = 0;
    this.lastActivity = 0;
    this.onLost = null;
  }

  get connected() {
    return !!this.proto;
  }

  /** mode: 'auto' | 'iso9141' | 'kwp_slow' | 'kwp_fast' */
  async connect(mode = 'auto') {
    const plan = mode === 'auto' ? ['slow', 'fast'] : [mode === 'kwp_fast' ? 'fast' : 'slow'];
    let lastErr;
    for (let i = 0; i < plan.length; i++) {
      try {
        if (plan[i] === 'slow') await this.#slowInit();
        else await this.#fastInit();
        this.lastActivity = now();
        this.#startKeepAlive();
        return { protocol: this.proto, label: PROTOCOLS[this.proto], keyBytes: this.keyBytes };
      } catch (e) {
        this.proto = null;
        lastErr = e;
        this.log('warn', `${plan[i] === 'slow' ? '5-baud' : 'Fast'} init failed: ${e.message}`);
        if (i < plan.length - 1) {
          this.log('info', 'Letting the ECU time out before the next attempt…');
          await sleep(3000);
        }
      }
    }
    throw new KLineError(`Could not wake the ECU (${lastErr?.message ?? 'unknown error'})`);
  }

  async #slowInit() {
    const t = this.t;
    this.log('info', 'Slow init: sending address 0x33 at 5 baud (~2 s)…');
    await t.setBreak(false);
    await sleep(400); // line idle before init
    const addr = 0x33;
    const bits = [0];
    for (let i = 0; i < 8; i++) bits.push((addr >> i) & 1);
    bits.push(1); // stop bit
    const t0 = now();
    for (let i = 0; i < bits.length; i++) {
      await sleepUntil(t0 + i * 200);
      await t.setBreak(bits[i] === 0);
    }
    await sleepUntil(t0 + 9 * 200 + 60);
    t.flushInput(); // drop garbage read back while the line was held low

    // ECU answers 0x55 20–300 ms after the stop bit, then two key bytes.
    const deadline = t0 + 2000 + 700;
    let gotSync = false;
    const stray = [];
    while (now() < deadline) {
      const b = await t.readExact(1, deadline - now());
      if (!b.length) break;
      if (b[0] === 0x55) { gotSync = true; break; }
      stray.push(b[0]);
    }
    if (stray.length) this.log('warn', `Unexpected bytes after the address: ${hex(stray.slice(0, 32))}`);
    if (!gotSync) {
      throw new KLineError(stray.length
        ? `ECU did not answer with 0x55 sync (got ${stray.length} other byte(s) — see log)`
        : 'ECU did not answer (no 0x55 sync byte, line silent)');
    }
    const kb = await t.readExact(2, 300);
    if (kb.length < 2) throw new KLineError('missing key bytes after sync');
    this.log('info', `Sync 0x55, key bytes ${hex(kb)}`);

    await sleep(25); // W4: 25–50 ms
    const inv = ~kb[1] & 0xff;
    await t.write(Uint8Array.of(inv));
    const resp = await t.readExact(2, 400); // our echo + ECU's inverted address (0xCC)
    if (!resp.includes(0xcc)) throw new KLineError(`ECU did not confirm (got ${hex(resp) || 'nothing'})`);

    this.keyBytes = kb;
    this.proto = kb[1] === 0x8f ? 'kwp_slow' : 'iso9141';
    this.lastRx = now();
    await sleep(this.opts.p3Ms);
  }

  async #fastInit() {
    const t = this.t;
    this.log('info', 'Fast init: 25 ms wake-up pulse + StartCommunication…');
    await t.setBreak(false);
    await sleep(350);
    const t0 = now();
    await t.setBreak(true);
    await sleepUntil(t0 + 25);
    await t.setBreak(false);
    await sleepUntil(t0 + 50);
    this.proto = 'kwp_fast';
    const msgs = await this.#exchange([0x81], { skipP3: true });
    const pos = msgs.find((m) => m.data[0] === 0xc1);
    if (!pos) throw new KLineError('no positive StartCommunication response');
    this.keyBytes = pos.data.slice(1, 3);
  }

  /** Send one OBD request; resolves with every ECU reply: [{ src, data }] */
  request(data) {
    return this.mutex.run(() => this.#exchange(data));
  }

  #frame(data) {
    const hdr = this.proto === 'iso9141' ? [0x68, 0x6a, 0xf1] : [0xc0 | data.length, 0x33, 0xf1];
    const f = [...hdr, ...data];
    f.push(checksum(f));
    return Uint8Array.from(f);
  }

  async #exchange(data, { skipP3 = false, quiet = false } = {}) {
    if (!this.proto) throw new KLineError('Not connected');
    const t = this.t;
    if (!skipP3) await sleepUntil(this.lastRx + this.opts.p3Ms);
    const frame = this.#frame(data);
    t.flushInput();
    if (this.opts.interByteMs > 0) {
      for (let i = 0; i < frame.length; i++) {
        await t.write(frame.subarray(i, i + 1));
        if (i < frame.length - 1) await sleep(this.opts.interByteMs);
      }
    } else {
      await t.write(frame);
    }
    if (!quiet) this.log('tx', hex(frame));
    await this.#consumeEcho(frame);

    let raw = await t.readUntilIdle(this.opts.p2MaxMs, this.opts.idleMs, 3000);
    let msgs = this.#parse(raw);
    // 7F xx 78 = "response pending": the ECU wants more time
    for (let g = 0; g < 10 && msgs.length && msgs.every((m) => m.data[0] === 0x7f && m.data[2] === 0x78); g++) {
      const more = await t.readUntilIdle(5000, this.opts.idleMs, 6000);
      if (!more.length) break;
      raw = more;
      msgs = this.#parse(more);
    }
    this.lastRx = now();
    this.lastActivity = this.lastRx;
    if (!raw.length) throw new KLineError('No response from ECU');
    if (!quiet) this.log('rx', hex(raw));
    if (!msgs.length) throw new KLineError(`Unreadable response: ${hex(raw)}`);
    return msgs;
  }

  /** Everything we send is read back by the cable; skip past our own bytes. */
  async #consumeEcho(frame) {
    const deadline = now() + 250 + frame.length * 5;
    let j = 0;
    while (j < frame.length) {
      const left = deadline - now();
      if (left <= 0) {
        throw new KLineError('No echo from the cable — is it plugged into the car with the ignition ON?');
      }
      const b = await this.t.readExact(1, left);
      if (!b.length) continue;
      j = b[0] === frame[j] ? j + 1 : b[0] === frame[0] ? 1 : 0;
    }
  }

  #parse(raw) {
    const out = [];
    let i = 0;
    if (this.proto === 'iso9141') {
      // No length byte: split where the running checksum matches and the next frame begins.
      while (i + 4 < raw.length) {
        let end = -1;
        for (let k = i + 4; k < raw.length; k++) {
          if (checksum(raw.subarray(i, k)) === raw[k] && (k + 1 === raw.length || raw[k + 1] === raw[i])) {
            end = k;
            break;
          }
        }
        if (end < 0) break;
        out.push({ src: raw[i + 2], data: raw.slice(i + 3, end) });
        i = end + 1;
      }
    } else {
      while (i < raw.length) {
        const fmt = raw[i];
        let p = i + 1;
        let src = null;
        if (fmt & 0xc0) { p++; src = raw[p++]; }
        let len = fmt & 0x3f;
        if (len === 0) len = raw[p++];
        if (p + len >= raw.length) break; // incomplete frame
        const cs = raw[p + len];
        if (checksum(raw.subarray(i, p + len)) !== cs) break;
        out.push({ src, data: raw.slice(p, p + len) });
        i = p + len + 1;
      }
    }
    if (i < raw.length) this.log('warn', `Ignored ${raw.length - i} trailing byte(s)`);
    return out;
  }

  #startKeepAlive() {
    this.#stopKeepAlive();
    let fails = 0;
    this.kaTimer = setInterval(async () => {
      if (this.kaBusy || !this.proto || now() - this.lastActivity < this.opts.keepAliveMs) return;
      this.kaBusy = true;
      try {
        await this.mutex.run(() => this.#exchange([0x01, 0x00], { quiet: true }));
        fails = 0;
      } catch {
        if (++fails >= 3) {
          this.log('error', 'Lost connection to the ECU (keep-alive failed)');
          this.close();
          this.onLost?.();
        }
      } finally {
        this.kaBusy = false;
      }
    }, 500);
  }

  #stopKeepAlive() {
    clearInterval(this.kaTimer);
    this.kaTimer = null;
  }

  close() {
    this.#stopKeepAlive();
    this.proto = null;
  }
}
