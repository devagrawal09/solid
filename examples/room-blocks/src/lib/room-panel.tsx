// The room as a LIVE SERVER COMPONENT (examples/room's room-panel, the
// component written as a block). The declaration is the one the data
// sources use: `live(GET(fn))`; the answer is a component, rendered on the
// server, whose markup the browser morphs as it changes. See the original's
// header for the transport story — nothing about it changes here.
//
// What the library's rules change: the component is a `$component`. Its
// setup joins (`$cleanup(join(…))`: the member leaves when the render is
// disposed), creates the two watchers as `$memo`s, and takes the client
// slot with `$snapshot` (a setup does not read); the view reads in holes.
import {
  $cleanup,
  $component,
  $memo,
  $snapshot,
  attempt,
  For,
  type TypedProps
} from "@solidjs/blocks";
import { GET, live } from "@solidjs/web/server-functions";
import type { Slot } from "@solidjs/web/frames";
import { join, topicOf, watchMembers, watchMessages, type Identity } from "./rooms";
import { LiveError } from "~/lib/errors";

export type ComposerSlot = Slot<{ room: string }>;

let renders = 0;

export const roomPanel = live(
  GET(async (room: string, me: Identity | null) => {
    "use server";
    // Which render this is. Read through a call so the compiler makes it a
    // live hole: on a conditional reconnect it is the one hole that crosses.
    const render = ++renders;
    const renderNo = () => render;
    return $component(function* RoomPanel(
      props: TypedProps<{ composer: ComposerSlot }, "RoomPanel">
    ) {
      const gone = new AbortController();
      yield* $cleanup(() => gone.abort());
      // Joining IS the render; the document's render (no identity) only watches.
      if (me) yield* $cleanup(join(room, me));
      const members = yield* $memo(function* () {
        return yield* attempt(
          () => watchMembers(room, gone.signal),
          cause => new LiveError(cause)
        );
      });
      const messages = yield* $memo(function* () {
        return yield* attempt(
          () => watchMessages(room, gone.signal),
          cause => new LiveError(cause)
        );
      });
      const Composer = yield* $snapshot(props.composer);
      return function* () {
        return (
          <section class="panel room-panel">
            <div class="panel-head">
              <h2>#{room}</h2>
              <span class="muted">
                {topicOf(room)} · render #{renderNo()}
              </span>
            </div>
            <div class="presence-row">
              <span class="count">{(yield* members).length}</span>
              <span class="muted"> here</span>
              <ul class="members">
                <For each={yield* members}>
                  {function* (m) {
                    return function* () {
                      return <li class={(yield* m.id) === me?.id ? "me" : ""}>{yield* m.name}</li>;
                    };
                  }}
                </For>
              </ul>
            </div>
            <ol class="messages">
              <For each={yield* messages}>
                {function* (m) {
                  return function* () {
                    return (
                      <li
                        class={{
                          system: (yield* m.from) === "system",
                          mine: (yield* m.from) === me?.name
                        }}
                      >
                        <span class="from">{yield* m.from}</span>
                        <span class="text">{yield* m.text}</span>
                        <time class="muted">{new Date(yield* m.at).toLocaleTimeString()}</time>
                      </li>
                    );
                  };
                }}
              </For>
            </ol>
            <Composer room={room} />
          </section>
        );
      };
    });
  })
);
