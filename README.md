# herdr-micro

[![CI](https://github.com/jkirkpatrick24/herdr-micro/actions/workflows/ci.yml/badge.svg)](https://github.com/jkirkpatrick24/herdr-micro/actions/workflows/ci.yml)

Ambient agent-status surface for [herdr](https://herdr.dev) on a Work Louder
Creator Micro 2 Pro. Six keys show the live state of six herdr *agents*; a
blocked agent holds steady amber and can be focused or interrupted from the
pad.

Keys are agents, not workspaces: a workspace routinely holds more than one
agent, and collapsing them onto a single key masked one agent's status with
another's. Slot labels read `workspace/kind`, matching herdr's sidebar rows.

Status: **hardware integration complete**. The daemon connects to the Creator
Micro 2 over HID, mirrors six agent slots to the key LEDs, and reconnects when
the pad is unplugged.

## Layout

Thirteen keys, a clickable dial and a planar joystick. The names are the legend
printed on the pad, and the same names the config file binds:

```
   ┌───────┬───────┬───────┬───────┐
   │   ◎   │ AG00  │ AG01  │   ✛   │     ◎  dial      ✛  joystick
   ├───────┼───────┼───────┼───────┤
   │ AG02  │ AG03  │ AG04  │ AG05  │
   ├───────┼───────┼───────┼───────┤
   │ ACT06 │ ACT07 │ ACT08 │ ACT09 │
   ├───────┴───────┼───────┴───────┤
   │  ACT10 ACT11  │     ACT12     │
   └───────────────┴───────────────┘
```

| Key | Bound to | Lit by the daemon |
| --- | --- | --- |
| `AG00`–`AG05` | Focus that slot's agent pane | Yes -- agent status |
| `ACT06` | Toggle the agent popup | No |
| `ACT07` | Send `Esc` to the focused pane | No |
| `ACT08` / `ACT09` | Previous / next tab | No |
| `ACT10` / `ACT11` | Unbound | No |
| `ACT12` | Send `Enter` to the focused pane | No |
| Dial | Turn navigates, click cycles mode | Ambient ring shows the mode |
| Joystick | Focus the pane in that direction | No |

`ACT10` and `ACT11` are the two switches under the single wide keycap, so a
press lands on one or the other; bind both to the same action if you bind
either. The six agent keys are fixed -- only the `ACT` keys are bindable.

The key LEDs carry the status. Resting states are dimmed to a quarter
brightness so a working or blocked key stands out across the room. The glyph is
what the stdout row prints; the popup spells the status out instead, tinted
from its own terminal-legible palette rather than these key colours:

| Status | Glyph | Key LED | Meaning |
| --- | --- | --- | --- |
| `working` | `▶` | blue `#1E5AA8`, breathing | The agent is running |
| `blocked` | `!` | amber `#C87A0A`, steady | Waiting on a human |
| `done` | `✓` | green `#1E8A3C`, steady | Idle after unseen background work |
| `idle` | `·` | `#302820`, dimmed | Nothing to do |
| `unknown` | `?` | borrows idle, dimmed | Unclassified, and transient |
| empty slot | `-` | off | No agent in this slot |

Breathing is the one moving state, and it marks `working` rather than
`blocked`: a blocked agent is the one you want to read at a glance, not chase
around a pulse. `unknown` is the only status with no colour of its own -- it
means unclassified, never an error, so it borrows idle's rather than inventing
an alarm colour. A brief `unknown` holds the previous colour and a sustained
one settles to idle after 2s, so it rarely reaches the keys at all.

The dial cycles `workspaces → agents → scroll`; rotation navigates the active
mode and clicking changes mode. Agent navigation is ordered by how much
attention the agent needs (`blocked` → `done` → `working` → `idle`), so one
turn from anywhere reaches whatever is blocked. The joystick focuses the
adjacent pane in the direction moved. The ambient ring -- the underglow
beneath the pad -- carries the mode, so what the dial is about to do is
readable before it is turned: Shopify green in workspace mode, blue in agent
mode, purple in scroll mode. All three are configurable, and a static colour
replaces the indicator entirely.

The daemon renders the six slots as a text row on stdout and logs transitions
and control failures to stderr, so the row stays parseable on its own.

## The pad layer

`layout/herdr-micro.layers.json` is the layer this project expects the pad to
be running, exported from Work Louder's Layers editor. Import it there to
reproduce the bindings; the daemon itself never reads the file.

Every key, the encoder and the joystick bind to OpenAI vendor keycodes
(`KV_OAI_AG00`--`AG05`, `KV_OAI_ACT06`--`ACT12`, `KV_OAI_ENC_*`, and a
`"type": "VENDOR"` joystick). A key bound this way emits a `v.oai.hid` vendor
report on the raw HID interface instead of a keystroke, so the pad drives the
daemon without typing into whatever window is focused.

Stock keycodes work too, and `src/hardware/protocol.ts` decodes both off the
same handle. `parseStandardInput` maps HID usages `0x04`--`0x09` onto
`AG00`--`AG05` and `0x0a`--`0x10` onto `ACT06`--`ACT12` -- `KC_A` through
`KC_M`, in order -- and reads the dial from the consumer usages for volume up,
volume down and play/pause. The joystick is a radial notification either way
(`kb.radial` under stock firmware, `v.oai.rad` here) and is configured by the
layer's `joystick` block rather than by a keycode. So a layer built entirely
from stock keycodes drives everything, and stays editable in the Layers web
editor. What it costs is that the keys also type their letters into the
focused window, which is what the vendor codes exist to avoid.

The same vendor namespace is why the Layers web editor blurs the layer and
says to use the ChatGPT app: it will import and flash the file, but it will
not edit a layer whose keycodes it does not own. Edit the JSON here and
re-import.

The export carries no `lights` block, so importing it leaves the backlight and
underglow as they were. The daemon drives the key LEDs and the ambient ring
over the vendor protocol regardless of what the layer stores.

## The popup

This repository is itself a herdr plugin. `herdr-plugin.toml` declares the
build, the daemon as a startup command, and a popup pane (`keys`) rendered by
`dist/popup.js`. `ACT06` closes an open popup, else opens that pane, else
falls back to a herdr notification when the plugin is not installed.

The popup takes no input but `q`, `Esc` or `Ctrl-C`, all of which close it.
Esc means a lone Esc: an arrow key arrives with the same first byte and is
ignored, so a stray cursor key -- or a paste into the pane underneath -- does
not close the panel.

## Run

Installed as a plugin, herdr runs the commands in `herdr-plugin.toml` itself.
To run the daemon directly:

```sh
npm install
npm run build
node dist/main.js
```

`npm run dev` builds and runs in one step. Disable the plugin first if it is
installed, or you will be running two daemons:

```sh
herdr plugin disable jkirkpatrick24.herdr-micro
```

herdr starts the plugin's daemon with the session, and the pad is opened
non-exclusively, so a second copy opens it quite happily and then cannot write
to it -- `IOHIDDeviceSetReport failed ... not permitted` on every paint, from
whichever instance lost. Both copies also subscribe to herdr and both append to
`metrics.jsonl`, so every transition is recorded twice. The daemon now gives up
a handle it cannot write to after three consecutive rejected writes and
re-enumerates on a backoff, but the fix is to run one of them.

macOS gates the pad behind Input Monitoring, granted per calling process.
Without it the open fails outright -- no lighting and no input, just
`Creator Micro unavailable` in the log and a retry every few seconds, with the
status row still going to stdout. `node tools/hid-probe.mjs` says which barrier
is being hit.

Linux gates it on the hidraw node's permissions instead, and the same symptom
means the same thing: the enumeration finds the pad and the open is refused.
Grant it with a udev rule at `/etc/udev/rules.d/70-herdr-micro.rules`:

```
KERNEL=="hidraw*", ATTRS{idVendor}=="303a", ATTRS{idProduct}=="8298", TAG+="uaccess"
```

Then `sudo udevadm control --reload-rules && sudo udevadm trigger`, and replug
the pad. `uaccess` hands the device to whoever is logged in at the seat, which
is what you want on a desktop; a fixed `GROUP="plugdev", MODE="0660"` is the
alternative for a headless box. The vendor and product ids must be lower-case
hex, and they are the same two constants `hardware/protocol.ts` matches on.

Linux support is CI-verified but not hardware-verified: the suite runs against
a fake HID backend on both platforms, and nobody has yet driven a real pad from
Linux. The daemon needs node-hid's hidraw backend there rather than libusb,
which is the default -- see the note above `nodeHid` in `hardware/device.ts`.

## Configuration

Optional TOML configuration lives at `~/.config/herdr-micro/config.toml`. Every
key is optional; a missing or malformed value is logged and falls back to the
default rather than rejecting the rest of the file. These are the defaults:

```toml
[colors]
idle = "#302820"
working = "#1E5AA8"
done = "#1E8A3C"
blocked = "#C87A0A"

[underglow]
brightness = 0.5

[underglow.dial]
workspaces = "#95BF47"
agents = "#2C6ECB"
scroll = "#9C6ADE"

[controls]
scroll_steps = 1
dial_mode_order = ["workspaces", "agents", "scroll"]

[controls.bindings]
ACT06 = "popup"
ACT07 = "escape"
ACT08 = "tab-prev"
ACT09 = "tab-next"
ACT10 = "none"
ACT11 = "none"
ACT12 = "enter"

[controls.joystick]
up = "pane"
down = "pane"
left = "pane"
right = "pane"

[metrics]
enabled = true
```

- **Colours** are `#rrggbb`. There is no key for `unknown` on purpose -- it
  borrows idle's, as described under [Layout](#layout).
- **`[underglow.dial]`** is one colour per dial mode. `#000000` is off rather
  than a shade, so a mode can still be given no ring at all.
- **`[underglow] brightness`** is `0` to `1` and applies to every mode.
- **`[underglow] color`** is unset by default. Setting it holds that one colour
  in every mode and gives up the indicator, leaving nothing to show which mode
  the dial is in -- so set it only if you would rather the pad glowed one
  colour than read the dial.
- **`scroll_steps`** is pages per dial detent, 1–12. Scrolling sends Page
  Up/Page Down to the focused pane as raw terminal input, because herdr's
  `pane.send_keys` vocabulary has no page key -- so what scrolls is whatever
  the application in that pane does with those keys, not herdr's own
  scrollback.
- **`dial_mode_order`** must list every mode exactly once, or some become
  unreachable. The first entry is the mode at startup.
- **Button actions**: `popup`, `escape`, `tab-prev`, `tab-next`, `enter`,
  `none`. Only the seven `ACT` keys are bindable; the agent keys are fixed.
- **Joystick actions**: `pane` or `none`.

## Environment

The daemon finds herdr's socket in this order, logging which branch it took --
the wrong socket connects, seeds nothing, and looks healthy:

- `HERDR_SOCKET_PATH`, used verbatim.
- `HERDR_SESSION`: tries `~/.config/herdr/sessions/<name>/herdr.sock`, then
  `herdr session list`. `HERDR_BIN_PATH` overrides the binary used for that.
- Otherwise `~/.config/herdr/herdr.sock`.

## Metrics

One NDJSON line per settled transition is appended to
`~/.local/state/herdr-micro/metrics.jsonl`: pane id, label, from, to, and time
spent in the previous state. Nothing gates on it -- it exists so "how often
does an agent block, and for how long" is answerable later. Writes are
fire-and-forget, and one failure disables metrics for the rest of the run.
Set `enabled = false` under `[metrics]` to turn it off.

## Tests

```sh
npm test               # vitest run
npm run test:watch     # vitest, watching
npm run test:coverage  # vitest run --coverage (text + lcov + html in coverage/)
```

Tests are authored in TypeScript and Vitest runs them straight from source, so
no build step stands between an edit and a result; `npm run typecheck` still
type-checks every fixture against the real `rpc.ts` types. Helpers live in
`src/testing/` and are excluded from both the production build
(`tsconfig.build.json`) and the coverage report.

Coverage thresholds are enforced (85% statements/functions/lines, 80%
branches), so a drop fails the run instead of only showing in the summary.
They sit under the current numbers deliberately: a bar set at the exact current
value fails on any honest refactor that adds an unexercised guard.

`src/testing/fake-herdr.ts` is a real unix-socket server rather than a stubbed
transport. The load-bearing facts under test are properties of the transport
itself (one request per connection; frames batched into the ack chunk), and a
stubbed `connect` would only assert against its own bookkeeping.

## Diagnostics

Three probes in `tools/`, run with plain `node`:

- **`herdr-probe.mjs`** re-runs every measured claim below. Read-only; it never
  focuses a pane, sends keys, or changes session state. `--watch <seconds>`
  also watches for status changes. Honours `HERDR_SOCKET_PATH`.
- **`hid-probe.mjs`** enumerates the pad's HID collections and listens for
  input reports (`LISTEN_MS` sets the window). Never writes to the device. Run
  it as your user, then under `sudo`, to tell a TCC denial from a permissions
  one.
- **`led-probe.mjs`** *writes* to the pad: a blue ambient test and a red
  Agent-Key-0 test. The changes are temporary firmware state, restorable
  through Work Louder Input. Run it from a plain terminal tab, not inside
  herdr: TCC attribution follows process ancestry, and herdr's server is a
  detached daemon that predates the Input Monitoring grant.

## herdr API notes

These were measured against herdr 0.8.2 / protocol 20 and shape the whole
design. See `src/herdr/rpc.ts`, which is the only file naming API methods.
Re-run every claim below with `node tools/herdr-probe.mjs` -- it is read-only
and never changes session state.

- **One request per connection.** The second request is never answered *and*
  the server closes the connection, taking any live subscription with it.
  Measured: a subscription socket sent a second request at t=3000ms and was
  closed at t=3095ms, while an identical control socket stayed open. So a
  subscription is a connection, a snapshot needs its own, and reusing a socket
  does not degrade gracefully -- it drops the stream.
- **`pane.updated` covers one redrawing pane, not the focused one.** It fires
  on any pane metadata change; an agent animating a spinner in its terminal
  title produces ~10 a second. Measured: 75 events in 8s, all for a single
  pane, none for the other eight -- and that pane was *not* the focused one.
  It is not a status source.
- **`pane.agent_status_changed` is the real status signal.** Change-driven,
  reliable for background panes, and requires a `pane_id` -- so the daemon
  holds one subscription per agent pane.
- **`workspace.updated` never fires on agent-status change**, despite
  `WorkspaceInfo` carrying an `agent_status` field. Do not derive colour from
  it; it looks right in a snapshot test and then never updates.
- **Statuses are `idle | working | blocked | done | unknown`.** There is no
  `error`. `done` is idle reached after *unseen* background work.
- **No `createdAt` anywhere.** Slot order follows sidebar order.
- **Membership and order come from `workspace.list`, not from events.** The
  list is authoritative; the events are only triggers to re-read it. This was
  originally justified by an out-of-order replay of historical workspace events
  on subscribe -- *that replay is unreproduced on 0.8.2*: subscribing to all
  four lifecycle events with three live workspaces replayed nothing. The
  re-read is kept anyway, on the weaker but sufficient grounds that the list is
  authoritative and membership changes are rare.
- **Several panes share one status subscription.** `events.subscribe` accepts
  many `pane.agent_status_changed` entries on one connection and delivers for
  all of them, so the daemon holds two sockets -- topology and status -- rather
  than one per agent. A pane cannot be *added* to a live subscription, so the
  status socket is rebuilt whenever the agent set changes; the `agent.list`
  refresh that triggers the rebuild carries authoritative statuses, which is
  what covers the gap.

## Agent integrations

Status is only authoritative for agents started *after* the herdr integration is
installed:

```sh
herdr integration install omp
herdr integration install claude
herdr integration install pi
```

Without them herdr falls back to screen-scraping, which misclassifies freely.
