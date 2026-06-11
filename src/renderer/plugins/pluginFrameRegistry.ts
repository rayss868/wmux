// Frame registry — connects palette command execution to mounted plugin
// frames (B-1). Module-level because the palette and the panel hosts live
// in unrelated component subtrees.
//
// Command delivery contract: if the plugin's frame is mounted, the command
// posts immediately. If not, the command is queued (bounded) and a
// panel-open request is broadcast so PluginPanels can expand the plugin's
// sidebar panel; the queue flushes when the frame registers.

type CommandPoster = (command: string) => void;

const posters = new Map<string, CommandPoster>();
const pendingCommands = new Map<string, string[]>();
const panelOpenListeners = new Set<(pluginName: string) => void>();

const MAX_PENDING_PER_PLUGIN = 8;

/** Called by PluginFrame once its bridge port is live. Returns unregister. */
export function registerFrame(pluginName: string, post: CommandPoster): () => void {
  posters.set(pluginName, post);
  const queued = pendingCommands.get(pluginName);
  if (queued) {
    pendingCommands.delete(pluginName);
    for (const cmd of queued) {
      try { post(cmd); } catch { /* frame torn down mid-flush */ }
    }
  }
  return () => {
    if (posters.get(pluginName) === post) posters.delete(pluginName);
  };
}

/** Palette → plugin. Queues + requests panel open when the frame isn't up. */
export function postPluginCommand(pluginName: string, command: string): void {
  const post = posters.get(pluginName);
  if (post) {
    try { post(command); } catch { /* frame torn down mid-post */ }
    return;
  }
  const queue = pendingCommands.get(pluginName) ?? [];
  if (queue.length < MAX_PENDING_PER_PLUGIN) queue.push(command);
  pendingCommands.set(pluginName, queue);
  for (const listener of panelOpenListeners) {
    try { listener(pluginName); } catch { /* one bad listener must not block */ }
  }
}

/** PluginPanels subscribes to expand the target plugin's panel. */
export function onPanelOpenRequest(listener: (pluginName: string) => void): () => void {
  panelOpenListeners.add(listener);
  return () => { panelOpenListeners.delete(listener); };
}
