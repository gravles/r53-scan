// Runs the full protocol stack against the simulated ECU: node test/sim-test.mjs
import assert from 'node:assert/strict';
import { SimulatorTransport } from '../js/transport/simulator.js';
import { KLine } from '../js/kline.js';
import { OBD } from '../js/obd.js';
import { ftdiDivisor } from '../js/transport/webusb-ftdi.js';
import { describeDtc } from '../js/dtc-codes.js';

const d = ftdiDivisor(10400);
assert.equal(d.value, 288 | (1 << 14));
assert.equal(describeDtc('P0171').text, 'System too lean (bank 1)');

async function run(simProto, mode) {
  const t = new SimulatorTransport({ protocol: simProto });
  await t.open();
  const logs = [];
  const k = new KLine(t, { log: (kind, m) => logs.push(`${kind} ${m}`) });
  const t0 = performance.now();
  const info = await k.connect(mode);
  const obd = new OBD(k);
  const sup = await obd.supportedPids();
  assert.ok(sup.has(0x0c) && sup.has(0x21) && !sup.has(0x42), 'supported PID set');
  const rpm = await obd.readPid(0x0c);
  assert.ok(rpm > 700 && rpm < 6000, `rpm ${rpm}`);
  const fuel = await obd.readPid(0x03);
  const mon = await obd.monitorStatus();
  assert.equal(mon.mil, true);
  assert.equal(mon.count, 2);
  assert.deepEqual(await obd.readDtcs(3), ['P0171', 'P0420']);
  assert.deepEqual(await obd.readDtcs(7), ['P0300']);
  const ff = await obd.freezeFrame();
  assert.equal(ff.dtc, 'P0171');
  const vin = await obd.vin();
  assert.equal(vin, 'SIMULATED0VIN0001');
  // unsupported PID: ISO 9141 ECU stays silent, KWP replies 7F
  await assert.rejects(obd.readPid(0x42));
  // keep-alive must hold the session across a 6 s pause (ECU drops after 5 s of silence)
  await new Promise((r) => setTimeout(r, 6000));
  await obd.readPid(0x05);
  await obd.clearDtcs();
  assert.deepEqual(await obd.readDtcs(3), []);
  assert.equal((await obd.monitorStatus()).mil, false);
  // polling speed
  const p0 = performance.now();
  for (let i = 0; i < 10; i++) await obd.readPid(0x0c);
  const rate = 10000 / (performance.now() - p0);
  k.close();
  await t.close();
  console.log(`✓ sim=${simProto} mode=${mode} → ${info.label} kb=${[...info.keyBytes].map((b) => b.toString(16))} ` +
    `fuel="${fuel}" connect+tests=${((performance.now() - t0) / 1000).toFixed(1)}s, ${rate.toFixed(1)} PIDs/s`);
}

await run('iso9141', 'auto');
await run('kwp', 'kwp_fast');
await run('kwp', 'auto');

// cable self-test: simulator echoes (cable OK); a transport that never echoes must say "not powered"
{
  const { testCable } = await import('../js/cabletest.js');
  const { ByteTransport } = await import('../js/transport/base.js');
  const sim = new SimulatorTransport({ protocol: 'iso9141' });
  await sim.open();
  const ok = await testCable(sim, () => {});
  await sim.close();
  assert.equal(ok.working.length, 4);
  assert.equal(ok.afterBreak, true);
  class Dead extends ByteTransport { async setLines() {} async setBreak() {} async write() {} }
  const dead = await testCable(new Dead(), () => {});
  assert.equal(dead.working.length, 0);
  assert.match(dead.verdict, /not powered/);
  console.log('✓ cable test (echo present / absent)');
}
console.log('all passed');
