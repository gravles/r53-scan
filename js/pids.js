// OBD-II Mode 01 PIDs (SAE J1979). dec() receives the data bytes after the PID.
const A = (d) => d[0];
const AB = (d) => d[0] * 256 + d[1];
const pct = (d) => (d[0] * 100) / 255;
const trim = (d) => ((d[0] - 128) * 100) / 128;
const temp = (d) => d[0] - 40;

export const BOOST = 0x100; // virtual: MAP − barometric pressure

const FUEL_STATUS = { 1: 'Open loop (warming up)', 2: 'Closed loop', 4: 'Open loop (load/decel)', 8: 'Open loop (fault)', 16: 'Closed loop (sensor fault)' };

export const OBD_STANDARDS = {
  1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD and OBD-II', 4: 'OBD-I', 5: 'Not OBD compliant',
  6: 'EOBD (Europe)', 7: 'EOBD and OBD-II', 8: 'EOBD and OBD', 9: 'EOBD, OBD and OBD-II',
  10: 'JOBD', 11: 'JOBD and OBD-II', 12: 'JOBD and EOBD', 13: 'JOBD, EOBD and OBD-II',
};

const o2 = (bank, sensor) => ({
  name: `O2 sensor voltage — bank ${bank}, sensor ${sensor}${sensor === 1 ? ' (upstream)' : sensor === 2 ? ' (downstream)' : ''}`,
  short: `O2 B${bank}S${sensor}`, unit: 'V', dec: (d) => d[0] / 200, digits: 2, min: 0, max: 1.1,
});

export const PIDS = {
  0x03: { name: 'Fuel system status', short: 'Fuel system', text: true, dec: (d) => FUEL_STATUS[d[0]] ?? `0x${d[0].toString(16)}` },
  0x04: { name: 'Calculated engine load', short: 'Load', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x05: { name: 'Coolant temperature', short: 'Coolant', unit: '°C', dec: temp, digits: 0, min: -40, max: 130 },
  0x06: { name: 'Short-term fuel trim — bank 1', short: 'STFT', unit: '%', dec: trim, digits: 1, min: -25, max: 25 },
  0x07: { name: 'Long-term fuel trim — bank 1', short: 'LTFT', unit: '%', dec: trim, digits: 1, min: -25, max: 25 },
  0x08: { name: 'Short-term fuel trim — bank 2', short: 'STFT B2', unit: '%', dec: trim, digits: 1, min: -25, max: 25 },
  0x09: { name: 'Long-term fuel trim — bank 2', short: 'LTFT B2', unit: '%', dec: trim, digits: 1, min: -25, max: 25 },
  0x0a: { name: 'Fuel pressure', short: 'Fuel press', unit: 'kPa', dec: (d) => d[0] * 3, digits: 0, min: 0, max: 765 },
  0x0b: { name: 'Intake manifold absolute pressure', short: 'MAP', unit: 'kPa', dec: A, digits: 0, min: 0, max: 255 },
  0x0c: { name: 'Engine speed', short: 'RPM', unit: 'rpm', dec: (d) => AB(d) / 4, digits: 0, min: 0, max: 7500 },
  0x0d: { name: 'Vehicle speed', short: 'Speed', unit: 'km/h', dec: A, digits: 0, min: 0, max: 220 },
  0x0e: { name: 'Ignition timing advance (cyl 1)', short: 'Timing', unit: '°', dec: (d) => d[0] / 2 - 64, digits: 1, min: -10, max: 50 },
  0x0f: { name: 'Intake air temperature', short: 'IAT', unit: '°C', dec: temp, digits: 0, min: -40, max: 100 },
  0x10: { name: 'Mass air flow', short: 'MAF', unit: 'g/s', dec: (d) => AB(d) / 100, digits: 1, min: 0, max: 200 },
  0x11: { name: 'Throttle position', short: 'Throttle', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x14: o2(1, 1), 0x15: o2(1, 2), 0x16: o2(1, 3), 0x17: o2(1, 4),
  0x18: o2(2, 1), 0x19: o2(2, 2), 0x1a: o2(2, 3), 0x1b: o2(2, 4),
  0x1f: { name: 'Run time since engine start', short: 'Run time', unit: 's', dec: AB, digits: 0, min: 0, max: 3600 },
  0x21: { name: 'Distance driven with MIL on', short: 'Dist. MIL on', unit: 'km', dec: AB, digits: 0, min: 0, max: 1000 },
  0x2c: { name: 'Commanded EGR', short: 'EGR cmd', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x2e: { name: 'Commanded evaporative purge', short: 'EVAP purge', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x2f: { name: 'Fuel tank level', short: 'Fuel', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x30: { name: 'Warm-ups since codes cleared', short: 'Warm-ups', unit: '', dec: A, digits: 0, min: 0, max: 255 },
  0x31: { name: 'Distance since codes cleared', short: 'Dist. since clear', unit: 'km', dec: AB, digits: 0, min: 0, max: 5000 },
  0x33: { name: 'Barometric pressure', short: 'Baro', unit: 'kPa', dec: A, digits: 0, min: 60, max: 110 },
  0x3c: { name: 'Catalyst temperature B1S1', short: 'Cat temp', unit: '°C', dec: (d) => AB(d) / 10 - 40, digits: 0, min: 0, max: 1000 },
  0x42: { name: 'Control module voltage', short: 'Battery', unit: 'V', dec: (d) => AB(d) / 1000, digits: 2, min: 10, max: 15 },
  0x43: { name: 'Absolute load', short: 'Abs load', unit: '%', dec: (d) => (AB(d) * 100) / 255, digits: 0, min: 0, max: 100 },
  0x44: { name: 'Commanded air-fuel equivalence ratio', short: 'Lambda cmd', unit: 'λ', dec: (d) => AB(d) / 32768, digits: 3, min: 0.7, max: 1.3 },
  0x45: { name: 'Relative throttle position', short: 'Rel throttle', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x46: { name: 'Ambient air temperature', short: 'Ambient', unit: '°C', dec: temp, digits: 0, min: -40, max: 50 },
  0x47: { name: 'Absolute throttle position B', short: 'Throttle B', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x49: { name: 'Accelerator pedal position D', short: 'Pedal D', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x4a: { name: 'Accelerator pedal position E', short: 'Pedal E', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  0x4c: { name: 'Commanded throttle actuator', short: 'Throttle cmd', unit: '%', dec: pct, digits: 0, min: 0, max: 100 },
  [BOOST]: { name: 'Supercharger boost (MAP − barometric)', short: 'Boost', unit: 'psi', virtual: true, needs: 0x0b, digits: 1, min: -14, max: 15 },
};

/** Gauges shown by default (filtered to what the car supports). */
export const GAUGE_DEFAULTS = [0x0c, BOOST, 0x05, 0x0f, 0x11, 0x0e, 0x04, 0x06, 0x07, 0x14, 0x15, 0x03, 0x0d, 0x42];

export const pidLabel = (pid) => PIDS[pid]?.name ?? `PID 0x${pid.toString(16).toUpperCase().padStart(2, '0')}`;
