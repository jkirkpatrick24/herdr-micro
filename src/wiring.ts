import type { HerdrClientEventSource } from './herdr/client.js';
import { eventName } from './herdr/rpc.js';
import { route } from './route.js';
import type { Store } from './state/store.js';

export type WiringHooks = {
  /** Called for each inbound frame that reaches the store, for counters. */
  onFrame?: () => void;
  /** Called before the store is blanked, so a caller can log the cause. */
  onDisconnected?: (reason: string) => void;
};

/**
 * The one place herdr client events become Store mutations. Both the daemon
 * and the popup need exactly this set.
 *
 * It lives here because when they each wired it by hand, the popup silently
 * lost `event` -> route() and with it workspace renames: workspace.renamed is
 * deliberately not a MEMBERSHIP_EVENT, so nothing re-read workspace.list to
 * repair the label and the popup showed a stale name until closed. One
 * subscription set in one place is what stops that drifting again.
 */
export function wireClientToStore(
  client: HerdrClientEventSource,
  store: Store,
  hooks: WiringHooks = {},
): void {
  // Authoritative state: each replaces what the store holds.
  client.on('seed', (snapshot) => store.applySeed(snapshot));
  client.on('workspaces', (list) => store.applyWorkspaces(list));
  client.on('agents', (list) => store.applyAgents(list));

  // Incremental updates between those refreshes.
  client.on('paneStatus', (status) => {
    hooks.onFrame?.();
    store.applyPaneStatus(status.paneId, status.status);
  });

  client.on('event', (frame) => {
    hooks.onFrame?.();
    route(store, eventName(frame), frame.data ?? {});
  });

  client.on('disconnected', (reason: string) => {
    hooks.onDisconnected?.(reason);
    store.setDisconnected();
  });
}
