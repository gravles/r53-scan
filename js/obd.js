import { PIDS, BOOST } from './pids.js';

const NRC = {
  0x10: 'general reject', 0x11: 'service not supported', 0x12: 'not supported / invalid format',
  0x21: 'busy, repeat request', 0x22: 'conditions not correct', 0x31: 'request out of range',
};

export class NegativeResponse extends Error {
  constructor(sid, code) {
    super(`ECU refused service 0x${sid.toString(16).padStart(2, '0')}: ${NRC[code] ?? `code 0x${code.toString(16)}`}`);
    this.code = code;
  }
}

/** Decode a 2-byte DTC into e.g. "P0171". */
export function decodeDtc(a, b) {
  const sys = 'PCBU'[a >> 6];
  return sys + ((a >> 4) & 3) + (a & 0x0f).toString(16).toUpperCase() + b.toString(16).toUpperCase().padStart(2, '0');
}

/** PID 0x01: MIL, DTC count and readiness monitors (spark-ignition layout). */
export function decodeMonitor([a, b, c, d]) {
  const tests = [];
  [['Misfire', 0], ['Fuel system', 1], ['Comprehensive components', 2]].forEach(([name, bit]) => {
    if (b & (1 << bit)) tests.push({ name, complete: !(b & (1 << (bit + 4))) });
  });
  if (!(b & 0x08)) {
    ['Catalyst', 'Heated catalyst', 'EVAP system', 'Secondary air', 'A/C refrigerant', 'O2 sensor', 'O2 sensor heater', 'EGR system']
      .forEach((name, i) => { if (c & (1 << i)) tests.push({ name, complete: !(d & (1 << i)) }); });
  }
  return { mil: !!(a & 0x80), count: a & 0x7f, tests };
}

export class OBD {
  constructor(kline) {
    this.k = kline;
    this.baro = 101.3;
  }

  /** Send a request and return the positive replies (throws on a negative/absent one). */
  async query(req) {
    const msgs = await this.k.request(req);
    const want = req[0] + 0x40;
    const pos = msgs.filter((m) => m.data[0] === want);
    if (pos.length) {
      // Prefer the engine ECU (0x10) when several modules answer.
      pos.sort((x, y) => (x.src === 0x10 ? -1 : 0) - (y.src === 0x10 ? -1 : 0));
      return pos;
    }
    const neg = msgs.find((m) => m.data[0] === 0x7f);
    if (neg) throw new NegativeResponse(req[0], neg.data[2]);
    throw new Error('Unexpected reply');
  }

  async supportedPids(mode = 1) {
    const sup = new Set();
    for (let base = 0; base <= 0xe0; base += 0x20) {
      let msgs;
      try {
        msgs = await this.query(mode === 2 ? [0x02, base, 0x00] : [0x01, base]);
      } catch {
        break;
      }
      for (const m of msgs) {
        const off = mode === 2 ? 3 : 2;
        for (let i = 0; i < 32; i++) if (m.data[off + (i >> 3)] & (0x80 >> (i & 7))) sup.add(base + i + 1);
      }
      if (!sup.has(base + 0x20)) break;
    }
    return sup;
  }

  async readRaw(pid) {
    const [m] = await this.query([0x01, pid]);
    return m.data.slice(2);
  }

  async readPid(pid) {
    const def = PIDS[pid];
    if (!def || def.virtual) throw new Error(`Unknown PID ${pid}`);
    return def.dec(await this.readRaw(pid));
  }

  boostPsi(mapKpa) {
    return (mapKpa - this.baro) * 0.145038;
  }

  /** Mode 03 (stored) or 07 (pending). K-line packs 3 codes per frame, zero-padded. */
  async readDtcs(mode = 3) {
    const msgs = await this.query([mode]);
    const codes = new Set();
    for (const m of msgs) {
      for (let i = 1; i + 1 < m.data.length; i += 2) {
        const a = m.data[i], b = m.data[i + 1];
        if (a || b) codes.add(decodeDtc(a, b));
      }
    }
    return [...codes];
  }

  async clearDtcs() {
    await this.query([0x04]);
  }

  async monitorStatus() {
    return decodeMonitor(await this.readRaw(0x01));
  }

  async vin() {
    const msgs = await this.query([0x09, 0x02]);
    msgs.sort((x, y) => x.data[2] - y.data[2]);
    const bytes = msgs.flatMap((m) => [...m.data.slice(3)]);
    return String.fromCharCode(...bytes.filter((b) => b >= 0x20 && b < 0x7f)).trim();
  }

  /** Freeze frame 0: the trigger DTC plus a snapshot of sensor values when it was set. */
  async freezeFrame() {
    const [m] = await this.query([0x02, 0x02, 0x00]);
    const a = m.data[3], b = m.data[4];
    if (!a && !b) return null;
    const out = { dtc: decodeDtc(a, b), values: [] };
    const sup = await this.supportedPids(2);
    for (const pid of [...sup].sort((x, y) => x - y)) {
      const def = PIDS[pid];
      if (!def || def.virtual || pid === 0x02) continue;
      try {
        const [r] = await this.query([0x02, pid, 0x00]);
        out.values.push({ pid, def, value: def.dec(r.data.slice(3)) });
      } catch { /* skip */ }
    }
    return out;
  }

  /** Best guess at ambient pressure, needed to turn MAP into boost. */
  async calibrateBaro(supported) {
    try {
      if (supported.has(0x33)) {
        this.baro = await this.readPid(0x33);
        return 'barometric PID';
      }
      if (supported.has(0x0b) && supported.has(0x0c) && (await this.readPid(0x0c)) < 50) {
        this.baro = await this.readPid(0x0b); // engine off: manifold = atmosphere
        return 'MAP with engine off';
      }
    } catch { /* fall through */ }
    this.baro = 101.3;
    return 'sea-level default';
  }
}

export { BOOST };
