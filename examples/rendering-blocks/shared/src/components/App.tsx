// The routes (examples/rendering's App, as a block). The pages are `lazy()`
// chunks, as in the original; each module's default export is a
// `$component`, and `adopt` keeps its type: a page may be pending (Profile)
// or fail (Stream's stream), and nothing here handles it — as in the
// original, the root does (CSR's render defers, streaming SSR holds the
// response, string SSR's entry wraps the app in a Loading). So the pages are
// rendered in call form (`{yield* Profile()}`), which hands their pending /
// failures on, and the app's type carries them.
import { lazy } from "solid-js";
import { $component, adopt, isPendingOf, Match, Switch } from "@solidjs/blocks";
import { Link, RouteHOC, useRouter } from "../router";
import Profile from "./Profile";

// @solidjs/vite-plugin's lazy() module-URL pass keys these against the client
// manifest automatically — no hand-written module keys needed.
const Home = adopt(lazy(() => import("./Home")));
const Settings = adopt(lazy(() => import("./Settings")));
const Stream = adopt(lazy(() => import("./Stream")));
const ErrorStream = adopt(lazy(() => import("./ErrorStream")));
const RevealPage = adopt(lazy(() => import("./Reveal")));
const Skeleton = adopt(lazy(() => import("./Skeleton")));

const App = RouteHOC(
  $component(function* Routes() {
    const { location, matches } = yield* useRouter();
    const pending = isPendingOf(location);

    return function* () {
      return (
        <>
          <ul class="inline">
            <li class={{ selected: yield* matches("index") }}>
              <Link path="">Home</Link>
            </li>
            <li class={{ selected: yield* matches("profile") }}>
              <Link path="profile">Profile</Link>
            </li>
            <li class={{ selected: yield* matches("settings") }}>
              <Link path="settings">Settings</Link>
            </li>
            <li class={{ selected: yield* matches("stream") }}>
              <Link path="stream">Stream</Link>
            </li>
            <li class={{ selected: yield* matches("error-stream") }}>
              <Link path="error-stream">Error Stream</Link>
            </li>
            <li class={{ selected: yield* matches("reveal") }}>
              <Link path="reveal">Reveal</Link>
            </li>
            <li class={{ selected: yield* matches("skeleton") }}>
              <Link path="skeleton">Skeleton</Link>
            </li>
          </ul>
          <div class={["tab", { pending: yield* pending }]}>
            <Switch>
              <Match when={yield* matches("index")}>{yield* Home()}</Match>
              <Match when={yield* matches("profile")}>{yield* Profile()}</Match>
              <Match when={yield* matches("settings")}>{yield* Settings()}</Match>
              <Match when={yield* matches("stream")}>{yield* Stream()}</Match>
              <Match when={yield* matches("error-stream")}>{yield* ErrorStream()}</Match>
              <Match when={yield* matches("reveal")}>{yield* RevealPage()}</Match>
              <Match when={yield* matches("skeleton")}>{yield* Skeleton()}</Match>
            </Switch>
          </div>
        </>
      );
    };
  })
);

export default App;
