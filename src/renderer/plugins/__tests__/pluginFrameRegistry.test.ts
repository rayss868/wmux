import { describe, it, expect, vi } from 'vitest';
import {
  registerFrame,
  postPluginCommand,
  onPanelOpenRequest,
} from '../pluginFrameRegistry';

describe('pluginFrameRegistry', () => {
  it('posts immediately to a registered frame', () => {
    const post = vi.fn();
    const unregister = registerFrame('p-immediate', post);
    postPluginCommand('p-immediate', 'cmd-a');
    expect(post).toHaveBeenCalledWith('cmd-a');
    unregister();
  });

  it('queues commands for unmounted frames, requests panel open, and flushes on register', () => {
    const opened: string[] = [];
    const offOpen = onPanelOpenRequest((name) => opened.push(name));

    postPluginCommand('p-lazy', 'cmd-1');
    postPluginCommand('p-lazy', 'cmd-2');
    expect(opened).toEqual(['p-lazy', 'p-lazy']);

    const post = vi.fn();
    const unregister = registerFrame('p-lazy', post);
    expect(post.mock.calls.map((c) => c[0])).toEqual(['cmd-1', 'cmd-2']);

    // Queue is drained — re-register must not replay.
    unregister();
    const post2 = vi.fn();
    registerFrame('p-lazy', post2)();
    expect(post2).not.toHaveBeenCalled();
    offOpen();
  });

  it('bounds the pending queue per plugin', () => {
    for (let i = 0; i < 20; i++) postPluginCommand('p-flood', `cmd-${i}`);
    const post = vi.fn();
    registerFrame('p-flood', post)();
    expect(post.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('unregister is a no-op when a newer frame replaced the registration', () => {
    const postOld = vi.fn();
    const unregisterOld = registerFrame('p-replace', postOld);
    const postNew = vi.fn();
    registerFrame('p-replace', postNew);
    unregisterOld(); // must NOT remove the new frame's poster
    postPluginCommand('p-replace', 'cmd-x');
    expect(postNew).toHaveBeenCalledWith('cmd-x');
    expect(postOld).not.toHaveBeenCalled();
  });
});
