/**
 * FIX-MULTI-WS — planChannelMessageDelivery
 *
 * The renderer's per-`channel.message` fan-out decision: which display cache to
 * touch (active workspace only) and which local workspaces to route the mention
 * into (every mentioned local workspace, active OR background). This is the
 * layer the FIRST multi-workspace attempt regressed — the daemon filter tests
 * passed, but same-workspace ROUTING broke at renderer runtime and was
 * undiagnosable remotely. These cases pin both directions:
 *   - same-ws (active) mention STILL routes (the regression), and
 *   - background-ws mention NOW routes (the fix),
 * so the two never drift apart again in a unit-visible way.
 */

import { describe, it, expect } from 'vitest';
import { planChannelMessageDelivery } from '../useChannelsEventSubscription';

const ACTIVE = 'ws-active';
const BG = 'ws-background';
const LOCAL = [ACTIVE, BG];

describe('planChannelMessageDelivery — display append (active workspace only)', () => {
  it('appends when the ACTIVE workspace is the sender', () => {
    const plan = planChannelMessageDelivery(ACTIVE, [ACTIVE, BG], [], ACTIVE, LOCAL);
    expect(plan.appendToDisplay).toBe(true);
  });

  it('appends when the ACTIVE workspace is a recipient (post from elsewhere)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE, BG], [], ACTIVE, LOCAL);
    expect(plan.appendToDisplay).toBe(true);
  });

  it('does NOT append when the post only concerns a BACKGROUND workspace', () => {
    // The active view holds no catalog for BG — appending would count unread
    // against a channel it doesn't display. Its view rebuilds on switch.
    const plan = planChannelMessageDelivery('ws-remote', [BG], [], ACTIVE, LOCAL);
    expect(plan.appendToDisplay).toBe(false);
  });

  it('does NOT append a fully third-party post (neither sender nor recipient is active)', () => {
    const plan = planChannelMessageDelivery('ws-x', ['ws-y'], [], ACTIVE, LOCAL);
    expect(plan.appendToDisplay).toBe(false);
  });
});

describe('planChannelMessageDelivery — mention routing (all local workspaces)', () => {
  it('routes a SAME-WS mention of the active workspace (the regression guard)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE], [ACTIVE], ACTIVE, LOCAL);
    expect(plan.routeWorkspaces).toEqual([ACTIVE]);
  });

  it('routes a CROSS-WS mention of a BACKGROUND workspace (the fix)', () => {
    // Viewing ACTIVE, a post mentions the BACKGROUND workspace's pane. Before
    // the fix this never reached the renderer; now it routes to BG.
    const plan = planChannelMessageDelivery('ws-remote', [BG], [BG], ACTIVE, LOCAL);
    expect(plan.routeWorkspaces).toEqual([BG]);
  });

  it('routes to BOTH when a single post mentions active + background', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE, BG], [ACTIVE, BG], ACTIVE, LOCAL);
    expect(new Set(plan.routeWorkspaces)).toEqual(new Set([ACTIVE, BG]));
  });

  it('does NOT route a mention of a NON-LOCAL workspace (its own renderer handles it)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE], ['ws-elsewhere'], ACTIVE, LOCAL);
    expect(plan.routeWorkspaces).toEqual([]);
  });

  it('routes nothing for a post with no mentions (plain message)', () => {
    const plan = planChannelMessageDelivery('ws-remote', [ACTIVE, BG], [], ACTIVE, LOCAL);
    expect(plan.routeWorkspaces).toEqual([]);
  });

  it('background delivery is INDEPENDENT of display: routes to BG while appendToDisplay is false', () => {
    // The crux of the fix in one assertion — a background mention delivers even
    // though its workspace contributes nothing to the on-screen display.
    const plan = planChannelMessageDelivery('ws-remote', [BG], [BG], ACTIVE, LOCAL);
    expect(plan.appendToDisplay).toBe(false);
    expect(plan.routeWorkspaces).toEqual([BG]);
  });
});
