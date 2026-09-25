/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts): EVENT-ONLY. Delegated handlers but no reactive
 * state — the handler writes the DOM through a ref. The graph needs only
 * delegated-event replay.
 */
export default function EventOnlyApp() {
  let out!: HTMLSpanElement;
  let clicks = 0;
  return (
    <section>
      <button id="inc" onClick={() => (out.textContent = `clicked ${++clicks}`)}>
        press
      </button>
      <span ref={out}>idle</span>
    </section>
  );
}
