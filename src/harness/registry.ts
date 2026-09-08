import { claude } from './claude.js';
import type { Harness } from './types.js';

/**
 * The harness for a pane running nothing this project has glue for.
 *
 * An empty control list makes the layer inert rather than absent: it still
 * opens, the ring still says so, and every key declines. That is the honest
 * rendering of "there is nothing I know how to do to this agent" -- falling
 * back to another harness's commands would type its vocabulary at something
 * that does not speak it.
 */
export const generic: Harness = { kind: 'generic', controls: [] };

const HARNESSES: readonly Harness[] = [claude];

/**
 * `kind` is `AgentInfo.agent`, whose vocabulary is herdr's own list of
 * supported agents (`agent.start --kind`): pi, claude, codex, omp and the rest.
 * Anything unrecognised -- including a pane with no agent at all -- is generic.
 */
export function harnessFor(kind: string | null | undefined): Harness {
  if (!kind) return generic;
  return HARNESSES.find((harness) => harness.kind === kind) ?? generic;
}

/**
 * Every key some harness binds to a control.
 *
 * Which harness is focused takes a round trip to learn, so without this the
 * layer would open a herdr connection on every key press it swallows, most of
 * which no harness could ever act on. A key absent from this set declines
 * against *any* harness, which is answerable locally.
 */
const CONTROL_KEYS: ReadonlySet<string> = new Set(
  HARNESSES.flatMap((harness) => harness.controls.map((control) => control.key)),
);

export function isControlKey(key: string): boolean {
  return CONTROL_KEYS.has(key);
}
