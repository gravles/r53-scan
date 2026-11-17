export const now = () => performance.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
export const sleepUntil = (t) => sleep(t - now());

export const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** K-line checksum: 8-bit sum of all bytes. */
export const checksum = (bytes) => {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xff;
  return s;
};

/** Serialises async work so polling, keep-alive and button actions never talk over each other. */
export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const res = this.#tail.then(fn);
    this.#tail = res.catch(() => {});
    return res;
  }
}
