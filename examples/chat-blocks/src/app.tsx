// The client side of the chat (examples/chat's App, as a block): the
// transcript state, the input, and autoscroll. The replies are server
// components (src/lib/ai.tsx); their markup arrives as HTML over frame
// streams and never exists here as templates or JSON.
//
// What the library's rules change here:
// - `App` is a `$component`: its setup creates the signals, the handlers
//   (`$event`s), the welcome reply's `$dynamic` and the autoscroll
//   (`$settled` + `$cleanup`, the original's `onSettled(() => { …; return
//   teardown })`); the view reads in holes.
// - Each message is a row block: its setup takes the prompt once
//   (`$snapshot`: a message's prompt never changes) and creates that row's
//   `$dynamic` over `reply(prompt)` — a `$dynamic` created in a view would be
//   re-created whenever the view re-rendered.
// - The copy handler is an `$event`. The server puts it in an event position
//   on each code block's button (`onClick={copy}`, see ai.tsx); delegation
//   resolves it here at dispatch.
import {
  $cleanup,
  $component,
  $dynamic,
  $event,
  $settled,
  $signal,
  $snapshot,
  attempt,
  For,
  Loading
} from "@solidjs/blocks";
import { reply, welcome } from "~/lib/ai";
import Status from "~/components/status";
import { ServerError } from "~/lib/errors";
import "./app.css";

interface Message {
  id: number;
  prompt: string;
}

let nextId = 0;

type Submit = SubmitEvent & { currentTarget: HTMLFormElement };
type Input = InputEvent & { currentTarget: HTMLInputElement };

// Behavior for SERVER-rendered elements: every code block in a reply carries
// a copy button the server renders with `onClick={copy}` — this handler,
// passed as a prop. It reads the code from the element it was clicked in, so
// one handler serves every block in every reply.
const copyCode = $event(function* (e: MouseEvent & { currentTarget: HTMLButtonElement }) {
  const button = e.currentTarget;
  const code = button.parentElement?.querySelector("code");
  if (!code) return;
  // Clipboard access can reject (unfocused window, missing permission) —
  // the label flip is the affordance either way.
  navigator.clipboard.writeText(code.textContent ?? "").catch(() => {});
  button.textContent = "Copied!";
  setTimeout(() => (button.textContent = "Copy"), 1200);
});

const App = $component(function* App() {
  const [messages, setMessages] = yield* $signal<Message[]>([]);
  const [draft, setDraft] = yield* $signal("");

  // The t=0 reply: rendered during the INITIAL document render, so the
  // assistant is already typing as the page loads; hydration adopts the
  // boundary in place and picks the generation up mid-sentence.
  const Welcome = yield* $dynamic(function* () {
    return yield* attempt(
      () => welcome(),
      cause => new ServerError(cause)
    );
  });

  // Follow the stream: bottom-pinning watches the transcript's SIZE (replies
  // grow through server-driven morphs, not a client render). Stay pinned
  // only while the reader is already at the bottom.
  let transcript!: HTMLOListElement;
  let pinned = true;

  const send = $event(function* (e: Submit) {
    e.preventDefault();
    const prompt = (yield* draft).trim();
    if (!prompt) return;
    yield* setMessages(m => [...m, { id: nextId++, prompt }]);
    yield* setDraft("");
    pinned = true;
  });
  const input = $event(function* (e: Input) {
    yield* setDraft(e.currentTarget.value);
  });

  yield* $settled(function* () {
    const doc = document.documentElement;
    const onScroll = () => {
      pinned = window.innerHeight + window.scrollY >= doc.scrollHeight - 120;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const follow = new ResizeObserver(() => {
      if (pinned) window.scrollTo({ top: doc.scrollHeight });
    });
    follow.observe(transcript);
    yield* $cleanup(() => {
      window.removeEventListener("scroll", onScroll);
      follow.disconnect();
    });
  });

  return function* () {
    return (
      <main class="chat">
        <header class="masthead">
          <h1>Solid Chat</h1>
          <p>
            Every reply is a <em>server component</em>: markdown rendered on the server, streamed in
            as HTML. Ask about <b>server components</b>, <b>signals</b>, or <b>markdown</b>.
          </p>
        </header>
        <ol class="transcript" ref={el => (transcript = el)}>
          <li class="exchange">
            <div class="bubble assistant">
              <Loading fallback={<p class="typing">▍</p>}>
                <Welcome
                  status={p => <Status progress={p.progress} stats={p.stats} usage={p.usage} />}
                  copy={copyCode}
                />
              </Loading>
            </div>
          </li>
          <For each={yield* messages}>
            {function* (m) {
              // One server-component call per message: the prompt is the
              // server input; `status` is a client position the server fills
              // with live args, rendered by the client <Status>.
              const prompt = yield* $snapshot(m.prompt);
              const Reply = yield* $dynamic(function* () {
                return yield* attempt(
                  () => reply(prompt),
                  cause => new ServerError(cause)
                );
              });
              return function* () {
                return (
                  <li class="exchange">
                    <div class="bubble user">{yield* m.prompt}</div>
                    <div class="bubble assistant">
                      <Loading fallback={<p class="typing">▍</p>}>
                        <Reply
                          status={p => (
                            <Status progress={p.progress} stats={p.stats} usage={p.usage} />
                          )}
                          copy={copyCode}
                        />
                      </Loading>
                    </div>
                  </li>
                );
              };
            }}
          </For>
        </ol>
        <form class="composer" onSubmit={send}>
          <input type="text" placeholder="Ask something…" value={yield* draft} onInput={input} />
          <button type="submit" disabled={!(yield* draft).trim()}>
            Send
          </button>
        </form>
      </main>
    );
  };
});

export default App;
