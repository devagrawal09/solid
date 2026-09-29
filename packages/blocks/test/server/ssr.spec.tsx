/**
 * Server rendering of blocks: the same components render to HTML, async
 * memos stream through Loading, row blocks and context work on the server.
 */
import { renderToString, renderToStream } from "@solidjs/web";

function stream(code: () => any): Promise<string> {
  return new Promise(resolve => {
    const chunks: string[] = [];
    renderToStream(code).pipe({
      write(chunk: string) {
        chunks.push(chunk);
      },
      end() {
        resolve(chunks.join(""));
      }
    });
  });
}
import {
  $component,
  $event,
  $memo,
  $signal,
  $store,
  attempt,
  createContext,
  For,
  Loading,
  perform,
  Show,
  type TypedProps
} from "@solidjs/blocks";

const strip = (html: string) =>
  html
    .replace(/ _hk=[^ >]*/g, "")
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");

describe("server rendering", () => {
  it("renders setup state, props, row blocks and context", () => {
    const Theme = createContext("light");
    const Item = $component(function* (props: TypedProps<{ text: string }>) {
      const theme = yield* Theme;
      return function* () {
        return <li class={theme}>{perform(props.text)}</li>;
      };
    });
    const App = $component(function* () {
      const [items] = yield* $signal(["a", "b"]);
      const [store] = yield* $store({ title: "list" });
      const click = $event(function* () {});
      return function* () {
        return (
          <section onClick={click}>
            <h1>{perform(store.title)}</h1>
            <ul>
              <For each={perform(items)}>{t => <Item text={t} />}</For>
            </ul>
            <For each={perform(items)}>
              {function* (t) {
                const [n] = yield* $signal(1);
                return function* () {
                  return (
                    <b>
                      {perform(t)}
                      {perform(n)}
                    </b>
                  );
                };
              }}
            </For>
            <Show when={perform(items).length > 1}>{() => <i>many</i>}</Show>
          </section>
        );
      };
    });
    const html = renderToString(() => (
      <Theme value="dark">
        <App />
      </Theme>
    ));
    expect(strip(html)).toBe(
      '<section><h1>list</h1><ul><li class="dark">a</li><li class="dark">b</li></ul><b>a1</b><b>b1</b><i>many</i></section>'
    );
  });

  it("an async memo resolves on the server", async () => {
    const User = $component(function* () {
      const user = yield* $memo(function* () {
        return yield* attempt(() => Promise.resolve({ name: "Ada" }));
      });
      return function* () {
        return <h3>{perform(user).name}</h3>;
      };
    });
    const html = await stream(() => <Loading fallback={<i>…</i>}>{User()}</Loading>);
    expect(strip(html)).toContain("<h3>Ada</h3>");
  });
});
