# R53 Scan

A browser-based OBD-II scanner for the 2004 MINI Cooper S (R53), built for a **K+DCAN FT232RL cable**.
Read and clear check-engine codes, view freeze frames and readiness monitors, and watch live engine data (including supercharger boost).

No install: plain HTML + JavaScript, no build step.

## Why this exists

A K+DCAN cable is **not** an ELM327, so apps like Torque or Car Scanner can't use it. It's a bare USB-to-K-line converter: the software has to wake the ECU and speak the protocol itself. This app does that:

- ISO 9141-2 with 5-baud init (what the R53 uses), plus KWP2000 slow/fast init as fallbacks
- K-line echo handling, checksums, reply framing, keep-alive (the ECU drops the session after 5 s of silence)
- OBD-II modes 01 (live), 02 (freeze frame), 03/07 (stored/pending codes), 04 (clear), 09 (VIN)

## Run it on the computer

```bash
python3 -m http.server 8053
```

Open **http://localhost:8053** in **Chrome or Edge** (Safari and Firefox have no Web Serial).

1. Pick **Simulator** and Connect to try everything without the car.
2. In the car: plug the cable into the OBD port (under the dash, driver's side), ignition **on**, plug USB into the laptop.
3. Interface: **USB cable — Web Serial**. Protocol: **Auto-detect**. Connect, then pick *FT232R USB UART* in Chrome's list.
4. The wake-up takes about 2–5 seconds.

Test suite (no car needed): `node test/sim-test.mjs`

### Cable switch
Use the **pre-2007** position (pins 7 and 8 bridged). If the ECU doesn't answer, try the other position.

### If it doesn't connect
- **"No echo from the cable"**: the cable isn't getting 12 V from the car. Check it's seated and the ignition is on.
- **"ECU did not answer"**: try the other switch position, then try turning **DTR** and/or **RTS** on under *Advanced* (some K+DCAN cables use these lines to choose K-line or D-CAN mode).
- Go to the **Log** tab, click **Download**, and keep the file. It has every byte sent and received.

## On an Android phone

Chrome on Android talks to the cable's FTDI chip over **WebUSB** with the OTG adapter. This option also sets the chip's latency to 1 ms, so timing is better than on the computer.
Browsers only allow USB access from `https://` or `localhost`, so the phone needs the app hosted over HTTPS (GitHub Pages, Vercel, etc.).
**iPhone won't work.** iOS doesn't let apps or browsers use USB serial cables.

## Limits

Generic OBD-II only reads the **engine computer's emissions data and codes**. ABS/DSC, airbag, body and gearbox fault memories on the R53 use BMW's own **DS2** protocol over the same K-line. That's what INPA uses, and it could be added later as a second layer on the same transport code.

## Files

| Path | What |
|---|---|
| `js/transport/webserial.js` | Desktop: OS serial driver via Web Serial, BREAK for wake-up |
| `js/transport/webusb-ftdi.js` | Android: drives the FT232R directly over WebUSB |
| `js/transport/simulator.js` | Byte-level fake ECU for testing |
| `js/kline.js` | ISO 9141-2 / KWP2000 link layer |
| `js/obd.js`, `js/pids.js`, `js/dtc-codes.js` | OBD services, PID formulas, code descriptions |
| `js/app.js`, `index.html`, `css/app.css` | UI |

Don't use the app while driving. Have a passenger hold the phone.
