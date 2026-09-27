// todos-local, compiled islands on the first interaction: the page loads
// only this loader. It holds the compiler's handler map for the island group
// (which events on which elements have handlers) and the group's event
// sources (`hashchange`, from App's load-time listener). The first handled
// event is stopped, the group's chunk is imported and activated, and the
// event is replayed; events arriving meanwhile queue behind it in order.
// Default actions are not replayed (a checkbox has already toggled; the
// handler reads the DOM state).
const HANDLED: Record<string, string> = {
  click: ".destroy,.clear-completed",
  input: ".toggle,.toggle-all",
  keydown: ".new-todo"
};
let state: 0 | 1 | 2 = 0; // idle, loading, active
const queue: Event[] = [];

function start() {
  if (state) return;
  state = 1;
  import("./islands-chunk").then(m => {
    m.activate(document.getElementById("root")!);
    state = 2;
    for (const e of queue.splice(0)) e.target!.dispatchEvent(replay(e));
  });
}
function replay(e: Event): Event {
  if (e instanceof KeyboardEvent)
    return new KeyboardEvent(e.type, { key: e.key, bubbles: true, cancelable: true });
  if (e instanceof MouseEvent) return new MouseEvent(e.type, { bubbles: true, cancelable: true });
  return new Event(e.type, { bubbles: true, cancelable: true });
}
for (const type of Object.keys(HANDLED))
  document.addEventListener(
    type,
    e => {
      if (state === 2 || !(e.target as Element).matches?.(HANDLED[type])) return;
      e.stopPropagation();
      queue.push(e);
      start();
    },
    true
  );
window.addEventListener("hashchange", start);
(globalThis as any).__hydrateMs = 0;
(globalThis as any).__readyAt = performance.now();
