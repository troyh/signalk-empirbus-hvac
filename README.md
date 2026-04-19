# signalk-empirbus-hvac

A [Signal K](https://signalk.org) server plugin that reads HVAC zone temperatures from an **EmpirBus MCU-150** over NMEA 2000, along with a standalone CLI for testing and protocol debugging.

Originally developed on an **Azimut 60 Fly** (six zones: Salon, Helm, Guest, VIP, Owner, Crew Cabin) but configurable for other boats using the same MCU.

## Status

- **Read**: zone temperatures, setpoints, and fan speeds — working.
- **Write** (change setpoints, fan speeds): not yet implemented.
- **Platform support**: Linux, macOS (dev), anywhere Node runs. Linux required for the SocketCAN transport.

## What it does

Once configured, the plugin connects to the CAN bus, impersonates a Raymarine N2K device, opens an HVAC session with the MCU, and cycles through each zone to capture the thermostat broadcast. Every 10 minutes (configurable), it publishes:

| Signal K path | Units | Source |
|---|---|---|
| `environment.inside.<zone>.temperature` | Kelvin | current temperature sensor reading |
| `environment.inside.<zone>.temperature.setpoint` | Kelvin | zone thermostat setpoint |
| `environment.inside.<zone>.fan.speed` | raw (milli-scale) | fan speed reported by MCU |

`<zone>` is the configured zone name camelCased (`Crew Cabin` → `crewCabin`). Only zones whose thermostat broadcast includes a given field get that path — e.g. on the Azimut 60 Fly, Guest and Owner report only `actual_temp`.

## How it works

The EmpirBus MCU-150 does not ship with public NMEA 2000 documentation for HVAC control. The protocol used here was **reverse-engineered from bus captures** of the Raymarine Axiom MFD talking to the MCU. The sequence the plugin performs on each poll cycle:

1. **Address claim** (PGN 60928) — we appear on the bus as an N2K device with a Raymarine manufacturer code (`0x73B`), because the MCU only grants HVAC sessions to Axiom-looking devices.
2. **ISO requests** (PGN 59904) for PGNs 126996, 126464, 126998 — the MCU responds with PGN 126464 to grant a session.
3. **Session registration** — two proprietary PGN 126720 fast-packet commands (11-byte with `b4=0x80`, then 13-byte with `b10=0x03`).
4. **Wait for MCU state dump** — the MCU sends a thermostat broadcast on PGN 126720 confirming the session is live.
5. **Cycle zones** — every 1.5 seconds, send a zone-switch command; the MCU replies with one thermostat broadcast per zone. The session times out at ~2 s of inactivity, which bounds how slowly we can cycle within a single session.
6. **Disconnect** and sleep until the next poll interval.

Re-registering each poll (rather than holding a single long-lived session) keeps bus traffic quiet — about 15 seconds of activity every 10 minutes by default.

### Why poll that way?

The MCU pushes a thermostat broadcast only in response to a zone switch. To read all zones we have to touch each one. Each touch costs one zone-switch burst (three frames) plus the 1.5 s interval. The plugin runs **two passes** per poll to make sure every zone gets captured, even if a broadcast is missed the first time.

### Temperature encoding

Temperatures are uint24 little-endian at bytes [6:9] of each thermostat entry, in millikelvin:

```
celsius = (raw - 273150) / 1000
```

The plugin converts to Kelvin (Signal K convention) before publishing.

### Transport

Two CAN transports are supported:

- **Yacht Devices YDWG-02** (TCP gateway) — cross-platform. Uses the YDWG RAW protocol.
- **SocketCAN** (Linux) — e.g. a CAN HAT on a Raspberry Pi. Requires `libsocketcan-dev` and the `socketcan` npm package (installed as a dependency; builds natively via node-gyp).

## Installation

```sh
# In your Signal K server directory:
npm install signalk-empirbus-hvac
```

Or for development, clone this repo and link it:

```sh
git clone https://github.com/<you>/signalk-empirbus-hvac
cd signalk-empirbus-hvac
npm install
npm run build
npm link

cd ~/.signalk
npm link signalk-empirbus-hvac
```

Restart the Signal K server, then enable and configure the plugin in the admin UI under **Server → Plugin Config → EmpirBus HVAC**.

## Configuration

All settings are exposed in the Signal K admin UI:

| Setting | Default | Notes |
|---|---|---|
| CAN transport | `ydwg` | `ydwg` or `socketcan` |
| YDWG-02 host | `192.168.1.1` | only used if transport is `ydwg` |
| YDWG-02 TCP port | `1457` | |
| SocketCAN interface | `can0` | only used if transport is `socketcan` |
| Poll interval (ms) | `600000` | 10 minutes; minimum 20 s (to avoid overlap) |
| MCU N2K source address | `3` | the EmpirBus MCU's address on the bus |
| Our N2K source address | `11` | the address this plugin claims — must not collide with anything else |
| Zones | Azimut 60 Fly set | list of `{name, action}` pairs; see below |

### Zones

Each zone entry has a **name** (used in Signal K paths) and an **action byte** — the command the MCU matches against in a zone-switch burst. Action bytes are boat-specific and must be captured from your MFD↔MCU traffic. The defaults are:

| Index | Name | Action (hex) | Action (decimal) |
|---|---|---|---|
| 0 | Salon | `0xfa` | 250 |
| 1 | Helm | `0xfb` | 251 |
| 2 | Guest | `0xfc` | 252 |
| 3 | VIP | `0xfd` | 253 |
| 4 | Owner | `0xfe` | 254 |
| 5 | Crew Cabin | `0xff` | 255 |

The admin UI accepts action bytes as decimal. To use hex, convert first (e.g. `0xfa` = 250).

## CLI tool

The [hvac_zone_switch.ts](src/hvac_zone_switch.ts) script runs a single poll cycle and prints the result. Useful for verifying connectivity before enabling the plugin, or for debugging zone captures on a new boat.

```sh
# Via YDWG-02 (default):
YDWG_HOST=192.168.1.1 YDWG_PORT=1457 npx ts-node src/hvac_zone_switch.ts

# Via SocketCAN:
SOCKETCAN_IFACE=can0 npx ts-node src/hvac_zone_switch.ts

# Override MCU source and starting zone, use a custom zones file:
npx ts-node src/hvac_zone_switch.ts 2 --mcu=5 --zones=./myboat-zones.json

# Dump every raw CAN frame:
DEBUG=1 npx ts-node src/hvac_zone_switch.ts
```

Flags:

- `[zone]` — starting zone index (0-based into the zones list); default `0`.
- `--mcu=N` / `--mcu-src=N` — MCU N2K source address; default `3`.
- `--my-src=N` — address we claim; default `11`.
- `--zones=FILE` — JSON file with `[{"name": "...", "action": 250}, ...]`.

Example `zones.json`:

```json
[
  { "name": "Salon",      "action": 250 },
  { "name": "Helm",       "action": 251 },
  { "name": "Guest",      "action": 252 },
  { "name": "VIP",        "action": 253 },
  { "name": "Owner",      "action": 254 },
  { "name": "Crew Cabin", "action": 255 }
]
```

## Project layout

```
src/
  hvac_core.ts         Protocol, transports, session — shared core
  hvac_zone_switch.ts  Standalone CLI (entry point for testing)
  plugin.ts            Signal K plugin entry point
```

`hvac_core.ts` has no Signal K dependency and can be used from any Node.js program that needs to talk to the MCU.

## Known caveats

- **Raymarine impersonation** — the address-claim NAME still hardcodes manufacturer code `0x73B`. If you already have an Axiom on the bus, the addresses must not collide (the default `mySrc=11` should be safe).
- **Action bytes are not automatically discovered** — new boats need a bus capture to find them.
- **Write support** — PUT handlers for setpoint / fan speed are not yet implemented. Read-only for now.
- **Session timeout window** — if the bus is noisy and a thermostat broadcast is lost, we catch it on the second pass; if both passes miss a zone, that zone's data is stale until the next poll interval.

## License

TBD.
