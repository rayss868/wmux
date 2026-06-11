import { describe, it, expect } from 'vitest';
import { PortWatcher, matchSessionPorts, type PortSnapshot } from '../portWatch';

function snap(
  procs: Array<[pid: number, ppid: number]>,
  listeners: Array<{ port: number; pid: number }>,
): PortSnapshot {
  return { ppidByPid: new Map(procs), listeners };
}

describe('matchSessionPorts', () => {
  it('attributes a port to the session whose PID tree owns it', () => {
    // shell 100 → node 200 → worker 300 (listens on 3000)
    const snapshot = snap(
      [[200, 100], [300, 200], [999, 1]],
      [{ port: 3000, pid: 300 }, { port: 8080, pid: 999 }],
    );
    const result = matchSessionPorts(snapshot, [{ sessionId: 's1', pid: 100 }]);
    expect(result.get('s1')).toEqual([{ port: 3000, pid: 300 }]);
  });

  it('includes a port owned by the root PID itself', () => {
    const snapshot = snap([], [{ port: 5173, pid: 100 }]);
    const result = matchSessionPorts(snapshot, [{ sessionId: 's1', pid: 100 }]);
    expect(result.get('s1')).toEqual([{ port: 5173, pid: 100 }]);
  });

  it('keeps sessions separate', () => {
    const snapshot = snap(
      [[200, 100], [400, 300]],
      [{ port: 3000, pid: 200 }, { port: 4000, pid: 400 }],
    );
    const result = matchSessionPorts(snapshot, [
      { sessionId: 'a', pid: 100 },
      { sessionId: 'b', pid: 300 },
    ]);
    expect(result.get('a')).toEqual([{ port: 3000, pid: 200 }]);
    expect(result.get('b')).toEqual([{ port: 4000, pid: 400 }]);
  });

  it('dedups identical port+pid pairs and sorts by port', () => {
    const snapshot = snap(
      [[200, 100]],
      [
        { port: 9000, pid: 200 },
        { port: 3000, pid: 200 },
        { port: 3000, pid: 200 }, // IPv4 + IPv6 duplicate
      ],
    );
    const result = matchSessionPorts(snapshot, [{ sessionId: 's1', pid: 100 }]);
    expect(result.get('s1')).toEqual([
      { port: 3000, pid: 200 },
      { port: 9000, pid: 200 },
    ]);
  });

  it('survives a ppid cycle without hanging', () => {
    const snapshot = snap([[200, 100], [100, 200]], [{ port: 1234, pid: 200 }]);
    const result = matchSessionPorts(snapshot, [{ sessionId: 's1', pid: 100 }]);
    expect(result.get('s1')).toEqual([{ port: 1234, pid: 200 }]);
  });
});

describe('PortWatcher', () => {
  it('emits on first non-empty observation and on change, not on steady state', async () => {
    let current: PortSnapshot = snap([[200, 100]], []);
    const events: Array<{ sessionId: string; ports: Array<{ port: number; pid: number }> }> = [];
    const watcher = new PortWatcher(
      () => [{ sessionId: 's1', pid: 100 }],
      { snapshot: async () => current },
    );
    watcher.on('ports', (e) => events.push(e));

    await watcher.tick(); // empty — no emit (nothing to clear)
    expect(events).toHaveLength(0);

    current = snap([[200, 100]], [{ port: 3000, pid: 200 }]);
    await watcher.tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sessionId: 's1', ports: [{ port: 3000, pid: 200 }] });

    await watcher.tick(); // unchanged — no emit
    expect(events).toHaveLength(1);

    current = snap([[200, 100]], []);
    await watcher.tick(); // server died — emits the empty set to clear
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ sessionId: 's1', ports: [] });
  });

  it('drops diff state for sessions that disappeared', async () => {
    let sessions = [{ sessionId: 's1', pid: 100 }];
    const snapshot = async (): Promise<PortSnapshot> =>
      snap([[200, 100]], [{ port: 3000, pid: 200 }]);
    const events: unknown[] = [];
    const watcher = new PortWatcher(() => sessions, { snapshot });
    watcher.on('ports', (e) => events.push(e));

    await watcher.tick();
    expect(events).toHaveLength(1);

    sessions = []; // session destroyed
    await watcher.tick();
    expect(events).toHaveLength(1);

    sessions = [{ sessionId: 's1', pid: 100 }]; // same id recreated
    await watcher.tick();
    expect(events).toHaveLength(2); // re-emits — diff state was reset
  });

  it('swallows snapshot failures silently', async () => {
    const watcher = new PortWatcher(
      () => [{ sessionId: 's1', pid: 100 }],
      { snapshot: async () => { throw new Error('powershell missing'); } },
    );
    await expect(watcher.tick()).resolves.toBeUndefined();
  });

  it('ignores sessions with invalid pids', async () => {
    const events: unknown[] = [];
    const watcher = new PortWatcher(
      () => [{ sessionId: 'bad', pid: 0 }],
      { snapshot: async () => snap([], [{ port: 1, pid: 0 }]) },
    );
    watcher.on('ports', (e) => events.push(e));
    await watcher.tick();
    expect(events).toHaveLength(0);
  });
});
