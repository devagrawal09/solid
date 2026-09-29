// examples/rendering's tiny router, written with generator blocks v2.
import {
  $component,
  $event,
  $memo,
  createSignal,
  createContext,
  type BlockComponent,
  type SourceAccessor,
  type TypedProps
} from "solid-js";
import { isServer, type JSX } from "@solidjs/web";

type RouterValue = [
  SourceAccessor<string>,
  {
    setLocation: (value: string) => void;
    matches: (match: string) => boolean;
  }
];

const RouterContext = createContext<RouterValue>();

/**
 * The original seeds a signal from a prop — `createSignal(initialPath(props.url))`
 * — in the component body. A v2 setup cannot read props, and `$signal` takes a
 * value, not a derivation: the initial path is a memo block of the prop, and
 * the location is a plain *writable derived* signal over it
 * (`createSignal(() => initial())`), which navigation then writes. (A memo
 * overridden by a separate signal renders the same, but `isPending(location)`
 * is then never true during a navigation — the original's "pending" tab
 * class disappears.)
 */
function RouteHOC(Comp: BlockComponent<{}, false, never>) {
  return $component(function* (props: TypedProps<{ url?: string }>) {
    const initial = yield* $memo(function* () {
      const initialPath = (yield* props.url) ?? (isServer ? "/" : window.location.pathname);
      return initialPath.slice(1) || "index";
    });
    const [location, setLocation] = createSignal(() => initial());
    const matches = (match: string) => match === (location() || "index");

    if (!isServer) {
      window.onpopstate = $event(function* () {
        setLocation(window.location.pathname.slice(1) || "index");
      });
    }

    return function* () {
      return (
        <RouterContext value={[location, { setLocation, matches }]}>
          <Comp />
        </RouterContext>
      );
    };
  });
}

/** The router from context (provided by `RouteHOC`). */
function* useRouter() {
  const router = yield* RouterContext;
  if (!router) {
    throw new Error("RouterContext is not available");
  }
  return router;
}

const Link = $component(function* (props: TypedProps<{ path: string; children?: JSX.Element }>) {
  const [, { setLocation }] = yield* useRouter();

  const navigate = $event(function* (event: MouseEvent) {
    event.preventDefault();
    const path = yield* props.path;
    window.history.pushState("", "", `/${path}`);
    setLocation(path);
  });

  return function* () {
    return (
      <a class="link" href={`/${yield* props.path}`} onClick={navigate}>
        {props.children}
      </a>
    );
  };
});

export { Link, RouteHOC, RouterContext, useRouter };
