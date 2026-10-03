// The server-component page (examples/room's `/`, as blocks). The room is
// ONE live server component (src/lib/room-panel.tsx): presence and the
// transcript are rendered on the server and arrive as HTML that keeps
// changing; the composer is a CLIENT slot the server positions inside it.
//
// What the library's rules change here:
// - `$dynamic` over `roomPanel(room, me)` is created in Panel's SETUP (a
//   dynamic created in a view is re-created when the view re-renders); its
//   body reads the props with `yield*`, and its reads are its own.
// - The composer's post is an `$event` (a Solid action: one transition,
//   waiting on `yield* attempt(() => send(...))`), called from the submit
//   `$event`.
// - Handlers are `$event`s; the room links are a row block over ROOMS.
import {
  $,
  $component,
  $dynamic,
  $event,
  $signal,
  $snapshot,
  attempt,
  For,
  latestOf,
  Loading,
  Show,
  type TypedProps
} from "@solidjs/blocks";
import type { RouteSectionProps } from "@solidjs/router";
import { useIdentity } from "~/lib/identity";
import { ChaosError, SendError } from "~/lib/errors";
import { roomPanel } from "~/lib/room-panel";
import { send, type Identity } from "~/lib/sources";
import StatusPill, { createWire, type WireControl } from "~/components/status-pill";

const ROOMS = ["lobby", "design", "infra", "random"];

type Submit = SubmitEvent & { currentTarget: HTMLFormElement };
type Input = InputEvent & { currentTarget: HTMLInputElement };

const Home = $component(function* Home(props: TypedProps<RouteSectionProps, "Home">) {
  const room = $(function* () {
    const q = String((yield* props.location.query.room) || "lobby");
    return ROOMS.includes(q) ? q : "lobby";
  });
  const me = yield* useIdentity();
  const wire = yield* createWire();
  return function* () {
    return (
      <div class="room">
        <header class="header">
          <div>
            <h1>Room, rendered on the server</h1>
            <p class="muted">
              One live server component: markup that keeps changing after it arrives, over one
              connection. The same room from live <em>data</em> sources is at{" "}
              <a href={`/live?room=${yield* room}`}>/live</a>.
            </p>
            <p class="muted rooms-inline">
              <For each={ROOMS}>
                {function* (name) {
                  return function* () {
                    return (
                      <a
                        href={`/?room=${yield* name}`}
                        class={(yield* name) === (yield* room) ? "current" : ""}
                      >
                        #{yield* name}
                      </a>
                    );
                  };
                }}
              </For>
            </p>
          </div>
          <div class="presence">
            <StatusPill wire={wire} label="room" />
            <Chaos />
          </div>
        </header>
        <main class="main">
          <Panel room={yield* room} me={yield* me} wire={wire} />
        </main>
      </div>
    );
  };
});
export default Home;

// `roomPanel(room, me)` is the reconnecting iterable itself, and `dynamic`
// is a memo: it pumps the iterable, and its value is the component the
// server answered with. A reconnect re-yields the SAME binding: nothing
// re-mounts, and the reconnected render's markup lands as one morph.
const Panel = $component(function* Panel(
  props: TypedProps<{ room: string; me: Identity | null; wire: WireControl }, "Panel">
) {
  const wire = yield* $snapshot(props.wire);
  const Room = yield* $dynamic(function* () {
    return wire.watch(roomPanel(yield* props.room, yield* props.me));
  });
  return function* () {
    return (
      <Loading fallback={<p class="muted">Rendering the room on the server…</p>}>
        <Room composer={p => <Composer room={p.room} />} />
      </Loading>
    );
  };
});

// The client slot. The server positions it (`<props.composer room={room} />`)
// and the browser fills it with this component, keyed by position so a
// morph keeps the instance — and the half-typed draft.
const Composer = $component(function* Composer(props: TypedProps<{ room: string }, "Composer">) {
  const me = yield* useIdentity();
  const [text, setText] = yield* $signal("");
  const [error, setError] = yield* $signal<string | undefined>(undefined);
  const shown = latestOf(text);
  const post = $event(function* (text: string) {
    const current = yield* me;
    if (!current) return;
    const room = yield* props.room;
    yield* setError(undefined);
    try {
      yield* attempt(
        () => send(room, Math.random().toString(36).slice(2, 10), current.name, text),
        cause => new SendError(cause)
      );
    } catch (err) {
      yield* setError(err instanceof Error ? err.message : String(err));
    }
  });
  const submit = $event(function* (e: Submit) {
    e.preventDefault();
    const trimmed = (yield* text).trim();
    if (!trimmed) return;
    yield* setText("");
    yield* post(trimmed);
  });
  const input = $event(function* (e: Input) {
    yield* setText(e.currentTarget.value);
  });
  return function* () {
    return (
      <form class="composer" onSubmit={submit}>
        <input
          value={yield* shown}
          onInput={input}
          placeholder={`Message #${yield* props.room}`}
          disabled={(yield* me) === null}
          autocomplete="off"
        />
        <button type="submit" disabled={(yield* me) === null}>
          Send
        </button>
        <Show when={yield* error}>
          <span class="muted post-error" role="alert">
            {yield* error}
          </span>
        </Show>
      </form>
    );
  };
});

// The chaos switch: the dev server destroys the socket of every open
// server-function response — this panel's standing render included.
const Chaos = $component(function* Chaos() {
  const [last, setLast] = yield* $signal("");
  const drop = $event(function* () {
    try {
      const res = yield* attempt(
        () => fetch("/__chaos/drop", { method: "POST" }),
        cause => new ChaosError(cause)
      );
      yield* setLast(
        res.ok
          ? yield* attempt(
              () => res.text(),
              cause => new ChaosError(cause)
            )
          : `no chaos route (${res.status}) — dev only`
      );
    } catch (e) {
      yield* setLast(String(e));
    }
  });
  return function* () {
    return (
      <span class="chaos">
        <button type="button" onClick={drop}>
          Kill every connection
        </button>
        <Show when={yield* last}>
          <span class="muted"> {yield* last}</span>
        </Show>
      </span>
    );
  };
});
