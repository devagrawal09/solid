// The client side of the SSR-SPA baseline (examples/hackernews-spa), written
// with generator blocks v2: every template lives here, so the comment tree
// renders in the browser from JSON and all of these components must ship to
// it in order to hydrate. The route components passed to the router, the
// nav, the story rows, the comments, the toggle and `App` are `$component`s.
//
// `App` creates `<Router>` in its SETUP and its view returns it. Written the
// natural way — `return function* () { return <Router>{props => …}</Router> }`
// — the app SSR-renders and hydrates, but the first client navigation to a
// route whose data is not cached yet re-creates the route component in an
// endless loop (≈17 000 setups in 30 s, the page freezes). See the README.
import { createRouter, defineRoute } from "@solidjs/router";
import { $component, Loading, type BlockComponent } from "solid-js";
import type { JSX } from "@solidjs/web";
import Nav from "~/components/nav";
import Stories, { preload as preloadStories } from "~/routes/stories";
import Story, { preload as preloadStory } from "~/routes/story";
import User, { preload as preloadUser } from "~/routes/user";
import "./app.css";

/**
 * The route components read their data asynchronously, so their views are
 * pending (`View<true, …>`), and the router's component type requires a
 * settled `JSX.Element`. The router renders the matched route inside App's
 * `<Loading>` (the layout below), which the type layer cannot see through
 * the router — hence this one cast, applied to every route.
 */
const routeComponent = <P,>(component: BlockComponent<P, boolean, never>) =>
  component as unknown as (props: P) => JSX.Element;

// Explicit route tree rather than the file routes a metaframework provides:
// this example is plain Vite. The feed paths are enumerated instead of a
// splat so the typed path proxy stays useful.
const Router = createRouter({
  routes: [
    defineRoute({
      path: ["/", "/top", "/new", "/show", "/ask", "/job"],
      component: routeComponent(Stories),
      preload: preloadStories
    }),
    defineRoute({ path: "/stories/:id", component: routeComponent(Story), preload: preloadStory }),
    defineRoute({ path: "/users/:id", component: routeComponent(User), preload: preloadUser })
  ]
});

const App = $component(function* () {
  // Created here, not in the view: see the note at the top of this file.
  const rendered = (
    <Router>
      {props => (
        <>
          <Nav />
          <Loading fallback={<div class="news-list-nav">Loading...</div>}>{props.children}</Loading>
        </>
      )}
    </Router>
  );
  return function* () {
    return rendered;
  };
});

export default App;
