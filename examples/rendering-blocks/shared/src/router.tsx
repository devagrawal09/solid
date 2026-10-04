// The example's tiny router (examples/rendering's, as blocks): the location
// is a `$signal` provided through context; `Link` navigates with an `$event`.
import {
  $component,
  $event,
  $memo,
  $signal,
  createContext,
  type BlockSetter,
  type Component,
  type Create,
  type Element,
  type Read,
  type Source,
  type TypedProps
} from "@solidjs/blocks";
import { isServer } from "@solidjs/web";

interface RouterValue {
  location: Source<string>;
  setLocation: BlockSetter<string>;
  /** `yield* matches("profile")`: whether that route is current (read where it is delegated to). */
  matches: (match: string) => Generator<Read<false, never>, boolean>;
}

/**
 * Outside a router there is no location to change (the original throws; a
 * setup does not fail, so the default is a detached router at "index",
 * created in the setup that asks for the router).
 */
function* detached(): Generator<Create<"memo">, RouterValue> {
  const location = yield* $memo(function* (): Generator<never, string> {
    return "index";
  });
  return {
    location,
    setLocation: () => {
      throw new Error("RouterContext is not available");
    },
    *matches(match) {
      return match === "index";
    }
  };
}

const RouterContext = createContext<RouterValue | undefined>(undefined);

function RouteHOC<P extends boolean, E>(Comp: Component<{}, P, E>) {
  return $component(function* Router(props: TypedProps<{ url?: string }, "Router">) {
    // The location the router navigated to, or none yet: then the URL a
    // server render starts from (a prop: read where the location is derived,
    // D-042), else the document's.
    const [navigated, setLocation] = yield* $signal<string | undefined>(undefined);
    const location = yield* $memo(function* () {
      const path = yield* navigated;
      if (path !== undefined) return path;
      const url = yield* props.url;
      return (url ?? (isServer ? "/" : window.location.pathname)).slice(1) || "index";
    });
    const matches = function* (match: string) {
      return match === ((yield* location) || "index");
    };

    if (!isServer) {
      window.onpopstate = $event(function* () {
        yield* setLocation(window.location.pathname.slice(1) || "index");
      });
    }

    return function* () {
      return (
        <RouterContext value={{ location, setLocation, matches }}>{yield* Comp()}</RouterContext>
      );
    };
  });
}

function* useRouter() {
  return (yield* RouterContext) ?? (yield* detached());
}

const Link = $component(function* Link(
  props: TypedProps<{ path: string; children: Element }, "Link">
) {
  const { setLocation } = yield* useRouter();
  const navigate = $event(function* (event: MouseEvent) {
    event.preventDefault();
    const path = yield* props.path;
    window.history.pushState("", "", `/${path}`);
    yield* setLocation(path);
  });
  return function* () {
    return (
      <a class="link" href={`/${yield* props.path}`} onClick={navigate}>
        {yield* props.children}
      </a>
    );
  };
});

export { Link, RouteHOC, RouterContext, useRouter };
