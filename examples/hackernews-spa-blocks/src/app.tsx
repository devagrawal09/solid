// The client side of the SSR-SPA baseline (examples/hackernews-spa's App, as
// a block): every template lives here, rendered in the browser from JSON.
//
// The router is created at module scope (as in the original) and the app's
// tree is built in App's SETUP: a router created or rendered inside a view
// would be re-created whenever the view re-rendered, and client navigation
// would never complete.
import { createRouter, defineRoute } from "@solidjs/router";
import { $component, Loading, type Component } from "@solidjs/blocks";
import Nav from "~/components/nav";
import Stories, { preload as preloadStories } from "~/routes/stories";
import Story, { preload as preloadStory } from "~/routes/story";
import User, { preload as preloadUser } from "~/routes/user";
import "./app.css";

/**
 * The router is plain Solid: its types do not see a block component's
 * pending / failures. A route renders under the app's <Loading>, so it may
 * be pending; its failures reach the app root, as the original's do (a
 * route's query may reject).
 */
function route<P>(component: Component<P, boolean, unknown>): Component<P, boolean, unknown> {
  return component;
}

const Router = createRouter({
  routes: [
    defineRoute({
      path: ["/", "/top", "/new", "/show", "/ask", "/job"],
      component: route(Stories),
      preload: preloadStories
    }),
    defineRoute({ path: "/stories/:id", component: route(Story), preload: preloadStory }),
    defineRoute({ path: "/users/:id", component: route(User), preload: preloadUser })
  ]
});

const App = $component(function* App() {
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
