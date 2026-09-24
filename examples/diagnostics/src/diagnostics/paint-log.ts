/**
 * A tiny "what the screen painted" recorder. Scenario readers append the text
 * they just rendered; the card shows the last few frames, which is how a tear
 * (two frames for one user action, the first inconsistent) becomes visible
 * without a profiler.
 *
 * It lives in an excluded root for the same reason the feed does: the log is
 * the observer, not the app.
 */
import { OBSERVE, createRoot, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import type { Accessor } from "solid-js";

export interface PaintLog {
  frames: Accessor<string[]>;
  record(frame: string): void;
  clear(): void;
}

export function createPaintLog(limit = 8): PaintLog {
  const log = createRoot(dispose => {
    if (OBSERVE) OBSERVE.exclude(getOwner()!);
    const owner = getOwner()!;
    const [frames, setFrames] = createSignal<string[]>([], {
      name: "observer:frames",
      ownedWrite: true
    });
    return {
      dispose,
      frames,
      record: (frame: string) =>
        runWithOwner(owner, () => setFrames(prev => [...prev, frame].slice(-limit))),
      clear: () => runWithOwner(owner, () => setFrames([]))
    };
  });
  onCleanup(() => log.dispose());
  return log;
}
