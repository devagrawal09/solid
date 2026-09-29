import { $component, isPending, lazy, Match, Switch } from "solid-js";
import { Link, RouteHOC, useRouter } from "../router";
import Profile from "./Profile";

// @solidjs/vite-plugin's lazy() module-URL pass keys these against the client
// manifest automatically — no hand-written module keys needed.
const Home = lazy(() => import("./Home"));
const Settings = lazy(() => import("./Settings"));
const Stream = lazy(() => import("./Stream"));
const ErrorStream = lazy(() => import("./ErrorStream"));
const RevealPage = lazy(() => import("./Reveal"));
const Skeleton = lazy(() => import("./Skeleton"));

const App = RouteHOC(
  $component(function* () {
    const [location] = yield* useRouter();
    // The original calls the router's `matches(name)` in each hole; a view
    // reads with `yield*`, so the same test is a helper generator here.
    function* at(name: string) {
      return name === ((yield* location) || "index");
    }

    return function* () {
      return (
        <>
          <ul class="inline">
            <li class={{ selected: yield* at("index") }}>
              <Link path="">Home</Link>
            </li>
            <li class={{ selected: yield* at("profile") }}>
              <Link path="profile">Profile</Link>
            </li>
            <li class={{ selected: yield* at("settings") }}>
              <Link path="settings">Settings</Link>
            </li>
            <li class={{ selected: yield* at("stream") }}>
              <Link path="stream">Stream</Link>
            </li>
            <li class={{ selected: yield* at("error-stream") }}>
              <Link path="error-stream">Error Stream</Link>
            </li>
            <li class={{ selected: yield* at("reveal") }}>
              <Link path="reveal">Reveal</Link>
            </li>
            <li class={{ selected: yield* at("skeleton") }}>
              <Link path="skeleton">Skeleton</Link>
            </li>
          </ul>
          {/* `isPending` has no block form: it takes the accessor. */}
          <div class={["tab", { pending: isPending(location) }]}>
            <Switch>
              <Match when={yield* at("index")}>
                <Home />
              </Match>
              <Match when={yield* at("profile")}>
                <Profile />
              </Match>
              <Match when={yield* at("settings")}>
                <Settings />
              </Match>
              <Match when={yield* at("stream")}>
                <Stream />
              </Match>
              <Match when={yield* at("error-stream")}>
                <ErrorStream />
              </Match>
              <Match when={yield* at("reveal")}>
                <RevealPage />
              </Match>
              <Match when={yield* at("skeleton")}>
                <Skeleton />
              </Match>
            </Switch>
          </div>
        </>
      );
    };
  })
);

export default App;
