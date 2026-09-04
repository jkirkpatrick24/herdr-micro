# herdr-micro

Ambient agent-status surface for [herdr](https://herdr.dev) on a Work Louder
Creator Micro 2 Pro. Six keys show the live state of six herdr workspaces; a
blocked agent breathes amber and can be focused or interrupted from the pad.

Status: **M1 complete** (herdr client + state store). M2 onward is gated on the
macropad being connected.

## Run

```sh
npm install
npm run build
node dist/main.js
```

Until the LED transport lands (M3/M4), the daemon renders the six slots as a
text row on stdout and logs transitions to stderr.

## Tests

```sh
npm test        # tsc && node --test dist
```

Tests are authored in TypeScript and run against the compiled output, so `tsc`
type-checks every fixture against the real `rpc.ts` types. Helpers live in
`src/testing/` -- deliberately not `src/test/`, because Node's runner treats
every file inside a directory named `test` as a test file.

`src/testing/fake-herdr.ts` is a real unix-socket server rather than a stubbed
transport. The load-bearing facts under test are properties of the transport
itself (one request per connection; frames batched into the ack chunk), and a
stubbed `connect` would only assert against its own bookkeeping.

## herdr API notes

These were measured against herdr 0.8.2 / protocol 20 and shape the whole
design. See `src/herdr/rpc.ts`, which is the only file naming API methods.

- **One request per connection.** A second request on the same socket is
  silently dropped -- no error, no ack, no close. A subscription is therefore a
  connection, and a snapshot needs its own.
- **`pane.updated` covers the focused pane only.** It ticks ~10 Hz
  unconditionally for whichever pane has focus and never fires for the others.
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
- **Workspace events are replayed on subscribe, out of order.** A
  `workspace_closed` can arrive before its own `workspace_created`, so applying
  them directly resurrects a workspace deleted long ago and pins it to a key.
  Membership and order therefore come from `workspace.list`; the events are only
  triggers to re-read it.

## Agent integrations

Status is only authoritative for agents started *after* the herdr integration is
installed:

```sh
herdr integration install omp
herdr integration install claude
herdr integration install pi
```

Without them herdr falls back to screen-scraping, which misclassifies freely.
