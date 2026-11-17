import { sleep, hex } from './util.js';

const PATTERN = [0x55, 0xaa, 0x33, 0xcc];
const COMBOS = [
  { dtr: false, rts: false },
  { dtr: true, rts: false },
  { dtr: false, rts: true },
  { dtr: true, rts: true },
];
const lines = (c) => `DTR ${c.dtr ? 'on' : 'off'}, RTS ${c.rts ? 'on' : 'off'}`;

/**
 * Checks the cable on its own, without the ECU: on a powered K-line every byte we send
 * is read straight back. Tries every DTR/RTS combination, then checks the echo still
 * works after a BREAK (the 5-baud wake-up is made of BREAKs).
 * Returns { working: combo[], afterBreak: boolean|null, verdict: string }.
 */
export async function testCable(t, log) {
  const echo = async () => {
    await sleep(150);
    t.flushInput();
    for (const b of PATTERN) {
      await t.write([b]);
      await sleep(3);
    }
    const got = await t.readUntilIdle(400, 60, 1000);
    const ok = got.length >= PATTERN.length && PATTERN.every((b, i) => got[i] === b);
    return { ok, got };
  };

  log('info', `Cable test: sending ${hex(PATTERN)} and listening for the echo…`);
  const working = [];
  for (const c of COMBOS) {
    await t.setLines(c.dtr, c.rts);
    const { ok, got } = await echo();
    if (ok) working.push(c);
    log(ok ? 'info' : 'warn', `  ${lines(c)}: ${ok ? 'echo OK' : got.length ? `wrong bytes back: ${hex(got)}` : 'nothing back'}`);
  }

  let afterBreak = null;
  if (working.length) {
    const c = working[0];
    await t.setLines(c.dtr, c.rts);
    await t.setBreak(true);
    await sleep(400);
    await t.setBreak(false);
    await sleep(300);
    afterBreak = (await echo()).ok;
    log(afterBreak ? 'info' : 'warn', `  After a 400 ms BREAK (${lines(c)}): ${afterBreak ? 'echo OK' : 'echo LOST'}`);
  }

  let verdict;
  if (!working.length) {
    verdict = 'No echo with any DTR/RTS setting: the K-line side of the cable is not powered or not connected. ' +
      'Check the ignition is fully ON (dash lights lit), the plug is pushed all the way in, and try the other cable switch position, then test again.';
  } else if (afterBreak === false) {
    verdict = `The cable works (${working.map(lines).join(' / ')}), but reading stops after the wake-up pulse. ` +
      'This is a browser/driver problem, not the car. Send the log so it can be fixed.';
  } else {
    verdict = `The cable works with ${working.map(lines).join(' / ')}. Set that under Advanced and Connect. ` +
      'If the ECU still does not answer, try the other cable switch position.';
  }
  log(working.length && afterBreak ? 'info' : 'warn', `Cable test result: ${verdict}`);
  return { working, afterBreak, verdict };
}
