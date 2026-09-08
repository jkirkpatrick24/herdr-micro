import type { Harness } from './types.js';

/**
 * Claude Code.
 *
 * One control for now: the model picker, opened with `/model` so the pad uses
 * the same complete picker as the slash command. The layer then drives the
 * list with the dial, joystick and commit/cancel keys.
 *
 * The model is *harness-owned* state: the pad opens the picker but cannot know
 * which model is selected afterwards, because the user can change it from the
 * keyboard at any time. So nothing here is lit to claim otherwise.
 *
 * ACT08 rather than an agent key: AG00-AG05 keep their navigation meaning
 * inside the layer, so the agent the layer acts on can be changed from within.
 */
export const claude: Harness = {
  kind: 'claude',
  ring: '#FF7A00',
  controls: [
    {
      id: 'model',
      label: 'model picker',
      key: 'ACT08',
      effect: { via: 'picker', open: { via: 'command', command: '/model' } },
      // Only open from a ready prompt, not while working or answering a permission.
      when: ['idle', 'done'],
    },
  ],
};
