// The live page (examples/room's `/live`, as blocks). Every panel is one
// shape of answer from sources.ts, read through a `$memo` (or, for the
// transcript, Solid's optimistic store), and the differences between them
// are all on the WIRE, which the status pills and the chaos switch show.
//
// What the library's rules change here:
// - A view that reads a pending source is pending, so what a <Loading>
//   covers is its own component, handed to the boundary as a view
//   (`<Loading>{Members({ who, me })}</Loading>`).
// - A memo over a stream or a promise may fail with anything, and the types
//   make that visible: the page's failures are handled at its root
//   (`Errored` around the page), each directory row handles its own (a row
//   is settled), and the summary keeps its <Errored>. The original lets such
//   a failure reach the app root; with no failure the markup is the same.
// - The transcript is an `$optimisticStore` over the room's stream (pending
//   until the first transcript lands) and posting is an `$event` (a Solid
//   action) that writes the row optimistically and waits with `until`.
// - Handlers are `$event`s.
import {
  $,
  $component,
  $event,
  $memo,
  $optimistic,
  $optimisticStore,
  $signal,
  attempt,
  Errored,
  For,
  latestOf,
  Loading,
  readStore,
  Show,
  until,
  type EventHandler,
  type Path,
  type Source,
  type TypedProps
} from "@solidjs/blocks";
import type { RouteSectionProps } from "@solidjs/router";
import { useIdentity } from "~/lib/identity";
import { ArchiveError, ChaosError, DeliveryError, SendError } from "~/lib/errors";
import {
  archive,
  presence,
  roomCard,
  send,
  summary,
  transcript,
  type Activity,
  type Identity,
  type Member,
  type Message,
  type Presence,
  type RoomCard
} from "~/lib/sources";
import StatusPill, { createWire, type Wire } from "~/components/status-pill";
import { LiveError } from "~/lib/errors";

const ROOMS = ["lobby", "design", "infra", "random"];

const Live = $component(function* Live(props: TypedProps<RouteSectionProps, "Live">) {
  const room = $(function* () {
    const q = String((yield* props.location.query.room) || "lobby");
    return ROOMS.includes(q) ? q : "lobby";
  });
  return function* () {
    return (
      <Errored
        fallback={err => (
          <div class="room">
            <p class="muted post-error">The page failed: {describe(err())}</p>
          </div>
        )}
      >
        {LivePage({ room })}
      </Errored>
    );
  };
});
export default Live;

const LivePage = $component(function* LivePage(props: TypedProps<{ room: string }, "LivePage">) {
  return function* () {
    return (
      <div class="room">
        {yield* Header({ room: props.room })}
        <div class="columns">
          <main class="main">{yield* Chat({ room: props.room })}</main>
          <aside class="side">
            <Directory current={yield* props.room} />
            {yield* Card({ room: props.room })}
            <Summary room={yield* props.room} />
            {yield* Archive({ room: props.room })}
          </aside>
        </div>
      </div>
    );
  };
});

// ---------------------------------------------------------------------------
// presence — a standing answer read through a memo. Joining IS the
// connection. The document render watches only (`me` is null on the server
// and until the tab's identity is minted); then the memo re-invokes and that
// connection joins.
const Header = $component(function* Header(props: TypedProps<{ room: string }, "Header">) {
  const me = yield* useIdentity();
  const wire = yield* createWire();
  const who = yield* $memo(function* () {
    const room2 = yield* props.room;
    const me2 = yield* me;
    return yield* attempt(
      () => wire.watch(presence(room2, me2)),
      cause => new LiveError(cause)
    );
  });
  // Am I in the room? Only once the tab's own connection has joined.
  const joined = $(function* () {
    const id = (yield* me)?.id;
    return id != null && (yield* who).members.some(m => m.id === id);
  });
  return function* () {
    return (
      <header class="header">
        <div>
          <h1>#{yield* props.room}</h1>
          <p class="muted">
            {yield* Loading({ fallback: "Joining…", children: () => Joined({ joined, me }) })} Open
            another tab to be two people.
          </p>
        </div>
        <div class="presence">
          {
            yield* Loading({
              fallback: <span class="muted">joining…</span>,
              children: () => Members({ who, me })
            })
          }
          <StatusPill wire={wire} label="presence" />
          <Chaos />
        </div>
      </header>
    );
  };
});

const Joined = $component(function* Joined(
  props: TypedProps<{ joined: Source<boolean, true, unknown>; me: Identity | null }, "Joined">
) {
  return function* () {
    return (
      <Show
        when={yield* props.joined}
        fallback="Not in the room yet — your connection is what joins."
      >
        You are <b>{yield* props.me.name}</b>, here while this tab's connection is open.
      </Show>
    );
  };
});

const Members = $component(function* Members(
  props: TypedProps<{ who: Source<Presence, true, unknown>; me: Identity | null }, "Members">
) {
  return function* () {
    return (
      <>
        <span class="count">{yield* props.who.members.length}</span>
        <span class="muted"> here · connection #{yield* props.who.connection}</span>
        <ul class="members">
          <For each={yield* props.who.members}>
            {function* (m) {
              return function* () {
                return (
                  <li class={(yield* m.id) === (yield* props.me.id) ? "me" : ""}>
                    {yield* m.name}
                  </li>
                );
              };
            }}
          </For>
        </ul>
      </>
    );
  };
});

// The chaos switch: asks the dev server to destroy the socket of every open
// server-function response (see vite.config.ts).
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

// ---------------------------------------------------------------------------
// transcript + composer — the same standing shape as presence, read through
// an OPTIMISTIC store (every yield is the whole transcript, reconciled by
// id). Posting is an `$event`, an action: the row shows at once (an optimistic write),
// the action sends, then HOLDS with `until` for the transcript to carry it.
type Row = Message & { pending?: boolean };

const Chat = $component(function* Chat(props: TypedProps<{ room: string }, "Chat">) {
  const me = yield* useIdentity();
  const wire = yield* createWire();
  const [store, setOptimistic] = yield* $optimisticStore(
    function* () {
      const room3 = yield* props.room;
      return yield* attempt(
        () => wire.watch(transcript(room3)),
        cause => new LiveError(cause)
      );
    },
    { messages: [] } as { messages: Row[] }
  );
  const [sending, setSending] = yield* $optimistic(false);
  const [error, setError] = yield* $signal<string | undefined>(undefined);
  const post = $event(function* (text: string) {
    const current = yield* me;
    if (!current) return;
    const room = yield* props.room;
    const id = Math.random().toString(36).slice(2, 10);
    yield* setError(undefined);
    yield* setSending(true);
    yield* setOptimistic(t => {
      t.messages.push({ id, from: current.name, text, at: Date.now(), pending: true });
    });
    try {
      yield* attempt(
        () => send(room, id, current.name, text),
        cause => new SendError(cause)
      );
      yield* until(
        readStore(store, s => s.messages.some(m => m.id === id)),
        cause => new DeliveryError(cause),
        { timeout: 10_000 }
      );
    } catch (err) {
      yield* setError(err instanceof Error ? err.message : String(err));
    }
  });
  // The first transcript arrives asynchronously: the store's reads are pending.
  const transcriptRows = store.messages;
  return function* () {
    return (
      <>
        {yield* Transcript({ messages: transcriptRows, wire })}
        <Composer room={yield* props.room} post={post} sending={sending} error={error} />
      </>
    );
  };
});

const Transcript = $component(function* Transcript(
  props: TypedProps<{ messages: Source<Row[], true, unknown>; wire: Wire }, "Transcript">
) {
  return function* () {
    return (
      <section class="panel transcript">
        <div class="panel-head">
          <h2>Transcript</h2>
          <StatusPill wire={yield* props.wire} />
        </div>
        {
          yield* Loading({
            fallback: <p class="muted">loading…</p>,
            children: () => Messages({ messages: props.messages })
          })
        }
      </section>
    );
  };
});

const Messages = $component(function* Messages(
  props: TypedProps<{ messages: Source<Row[], true, unknown> }, "Messages">
) {
  const me = yield* useIdentity();
  return function* () {
    return (
      <ol class="messages">
        <For each={yield* props.messages}>
          {function* (m) {
            return function* () {
              return (
                <li
                  class={{
                    system: (yield* m.from) === "system",
                    mine: (yield* m.from) === (yield* me)?.name,
                    pending: !!(yield* m.pending)
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
    );
  };
});

type Submit = SubmitEvent & { currentTarget: HTMLFormElement };
type Input = InputEvent & { currentTarget: HTMLInputElement };

// The composer is disabled until this tab has an identity. It is NOT
// disabled while a post is in flight: actions run concurrently.
const Composer = $component(function* Composer(
  props: TypedProps<
    {
      room: string;
      // an event that does async work (it sends, then waits for the transcript)
      post: EventHandler<[text: string], SendError | DeliveryError, void, boolean, true>;
      sending: boolean;
      error: string | undefined;
    },
    "Composer"
  >
) {
  const me = yield* useIdentity();
  const [text, setText] = yield* $signal("");
  const shown = latestOf(text);
  const submit = $event(function* (e: Submit) {
    e.preventDefault();
    const trimmed = (yield* text).trim();
    if (!trimmed) return;
    // One transaction with the post: the clear lands when the post settles,
    // and the input shows `latestOf(text)` meanwhile.
    yield* setText("");
    yield* (yield* props.post)(trimmed);
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
        <Show when={yield* props.sending}>
          <span class="muted sending">sending…</span>
        </Show>
        <Show when={yield* props.error}>
          <span class="muted post-error" role="alert">
            {yield* props.error}
          </span>
        </Show>
      </form>
    );
  };
});

// ---------------------------------------------------------------------------
// directory — one more live source per room, watching only (no identity).
// A row is settled, so each entry handles its count's pending and failure.
const Directory = $component(function* Directory(
  props: TypedProps<{ current: string }, "Directory">
) {
  return function* () {
    return (
      <section class="panel">
        <div class="panel-head">
          <h2>Rooms</h2>
        </div>
        <ul class="directory">
          <For each={ROOMS}>{name => <DirectoryEntry name={name} current={props.current} />}</For>
        </ul>
      </section>
    );
  };
});

const DirectoryEntry = $component(function* DirectoryEntry(
  props: TypedProps<{ name: string; current: string }, "DirectoryEntry">
) {
  const wire = yield* createWire();
  const who = yield* $memo(function* () {
    const name2 = yield* props.name;
    return yield* attempt(
      () => wire.watch(presence(name2, null)),
      cause => new LiveError(cause)
    );
  });
  return function* () {
    return (
      <li class={(yield* props.name) === (yield* props.current) ? "current" : ""}>
        <a href={`/live?room=${yield* props.name}`}>#{yield* props.name}</a>
        <span class="count-small">
          <Errored fallback="!">
            {Loading({ fallback: "…", children: () => Count({ who }) })}
          </Errored>
        </span>
        <span class={`dot dot-${yield* wire.status}`} title={yield* wire.status} />
      </li>
    );
  };
});

const Count = $component(function* Count(
  props: TypedProps<{ who: Source<Presence, true, unknown> }, "Count">
) {
  return function* () {
    return <>{yield* props.who.members.length}</>;
  };
});

// ---------------------------------------------------------------------------
// roomCard — a NESTED-async answer: one object, a promise and a bounded
// stream inside it. The child memos read INTO the answer.
const Card = $component(function* Card(props: TypedProps<{ room: string }, "Card">) {
  const wire = yield* createWire();
  // `live`'s call type is the answer itself (`RoomCard & { onstatus }`),
  // though the call is a stream of it: widened here to what it is — pending
  // until the first answer, and failing with whatever the stream rejects with.
  const card: Source<RoomCard, boolean, unknown> = yield* $memo(function* () {
    return wire.watch(roomCard(yield* props.room));
  });
  const members = yield* $memo(function* () {
    const card2 = yield* card;
    return yield* attempt(
      () => card2.members,
      cause => new LiveError(cause)
    );
  });
  const activity = yield* $memo(function* () {
    const card3 = yield* card;
    return yield* attempt(
      () => card3.activity,
      cause => new LiveError(cause)
    );
  });
  return function* () {
    return (
      <section class="panel">
        <div class="panel-head">
          <h2>Room card</h2>
          <StatusPill wire={wire} />
        </div>
        {
          yield* Loading({
            on: props.room,
            fallback: <p class="muted">loading card…</p>,
            children: () => CardBody({ card, members, activity })
          })
        }
      </section>
    );
  };
});

const CardBody = $component(function* CardBody(
  props: TypedProps<
    {
      card: Source<{ topic: string; connection: number }, true, unknown>;
      members: Source<Member[], true, unknown>;
      activity: Source<Activity, true, unknown>;
    },
    "CardBody"
  >
) {
  return function* () {
    return (
      <>
        <p>
          <b>{yield* props.card.topic}</b>
          <span class="muted"> · connection #{yield* props.card.connection}</span>
        </p>
        <p>
          {
            yield* Loading({
              fallback: <span class="muted">counting members…</span>,
              children: () => MemberCount({ members: props.members })
            })
          }
        </p>
        <p>
          {
            yield* Loading({
              fallback: <span class="muted">sampling activity…</span>,
              children: () => ActivityLine({ activity: props.activity })
            })
          }
        </p>
      </>
    );
  };
});

const MemberCount = $component(function* MemberCount(
  props: TypedProps<{ members: Source<Member[], true, unknown> }, "MemberCount">
) {
  return function* () {
    const n = props.members.length;
    return (
      <>
        {yield* n} member{(yield* n) === 1 ? "" : "s"} when the card was cut
      </>
    );
  };
});

const ActivityLine = $component(function* ActivityLine(
  props: TypedProps<{ activity: Source<Activity, true, unknown> }, "ActivityLine">
) {
  // A row is settled: the (pending) activity is read once, into one flag per tick.
  const ticks = $(function* () {
    const { of, tick } = yield* props.activity;
    return Array.from({ length: of }, (_, i) => i < tick);
  });
  return function* () {
    return (
      <>
        <span class="ticks">
          <For each={yield* ticks}>
            {function* (on) {
              return function* () {
                return <span class={(yield* on) ? "tick on" : "tick"} />;
              };
            }}
          </For>
        </span>
        <span class="muted">
          {" "}
          {yield* props.activity.posts} post{(yield* props.activity.posts) === 1 ? "" : "s"} in the
          last minute
        </span>
      </>
    );
  };
});

// ---------------------------------------------------------------------------
// summary — an UNDECLARED slow stream at the data address. Kill the
// connections while it is running and it errors: <Errored> shows the
// failure and Regenerate is an explicit new call. Client-only
// (`ssrSource: "client"`).
const Summary = $component(function* Summary(props: TypedProps<{ room: string }, "Summary">) {
  const [attemptNo, setAttempt] = yield* $signal(1);
  const regenerate = $event(function* (reset: () => void) {
    yield* setAttempt(a => a + 1);
    reset();
  });
  return function* () {
    return (
      <section class="panel">
        <div class="panel-head">
          <h2>Summary</h2>
          <span class="muted">undeclared</span>
        </div>
        <Errored
          fallback={(err, reset) => (
            <div class="error">
              <p>The stream died: {describe(err())}</p>
              <button type="button" onClick={() => regenerate(reset)}>
                Regenerate
              </button>
            </div>
          )}
        >
          {Loading({
            fallback: <p class="muted">summarizing…</p>,
            children: () => SummaryText({ room: props.room, attempt: attemptNo })
          })}
        </Errored>
      </section>
    );
  };
});

const SummaryText = $component(function* SummaryText(
  props: TypedProps<{ room: string; attempt: number }, "SummaryText">
) {
  const text = yield* $memo(
    function* () {
      const room4 = yield* props.room;
      const attempt2 = yield* props.attempt;
      return yield* attempt(
        () => summary(room4, attempt2),
        cause => new LiveError(cause)
      );
    },
    { ssrSource: "client" }
  );
  return function* () {
    return <p>{yield* text}</p>;
  };
});

// ---------------------------------------------------------------------------
// archive — a slow plain read in its own boundary. `on: room` makes a room
// switch show the fallback for the new room at once. A failure is an
// ArchiveError, handled with the page's other failures (`Errored` at its root).
const Archive = $component(function* Archive(props: TypedProps<{ room: string }, "Archive">) {
  const stats = yield* $memo(function* () {
    const room = yield* props.room;
    return yield* attempt(
      () => archive(room),
      cause => new ArchiveError(cause)
    );
  });
  return function* () {
    return (
      <section class="panel">
        <div class="panel-head">
          <h2>Archive</h2>
          <span class="muted">slow, plain</span>
        </div>
        {
          yield* Loading({
            on: props.room,
            fallback: <p class="muted">counting the archive (4s)…</p>,
            children: () => ArchiveCount({ stats })
          })
        }
      </section>
    );
  };
});

const ArchiveCount = $component(function* ArchiveCount(
  props: TypedProps<{ stats: { room: string; total: number } }, "ArchiveCount">
) {
  return function* () {
    return (
      <p>
        {yield* props.stats.total} message{(yield* props.stats.total) === 1 ? "" : "s"} ever in #
        {yield* props.stats.room}
      </p>
    );
  };
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { Path };
