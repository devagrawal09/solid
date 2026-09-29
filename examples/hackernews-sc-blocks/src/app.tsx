// The app: the same router, routes and layout as ../../hackernews/src/app.tsx.
// There is no server-component API here and no `"use server"` on any
// markup: the compiler reads the route table (createRouter from
// @solidjs/router) and derives a frame per route from the inert proof —
// each route's view is rendered in the document on first load and fetched
// as HTML, with its server call's arguments, on client navigation.
import { createRouter, defineRoute } from "@solidjs/router";
import { $component, Loading } from "solid-js";
import Stories, { preload as preloadStories } from "./routes/stories";
import Story, { preload as preloadStory } from "./routes/story";
import User, { preload as preloadUser } from "./routes/user";

const Router = createRouter({
  routes: [
    defineRoute({
      path: ["/", "/top", "/new", "/show", "/ask", "/job"],
      component: Stories,
      preload: preloadStories
    }),
    defineRoute({ path: "/stories/:id", component: Story, preload: preloadStory }),
    defineRoute({ path: "/users/:id", component: User, preload: preloadUser })
  ]
});

// Static chrome: inert, rendered once on the server, never refetched.
const Nav = $component(function* () {
  return function* () {
    return (
      <header class="header">
        <nav class="inner">
          <a href="/">
            <strong>HN</strong>
          </a>
          <a href="/new">
            <strong>New</strong>
          </a>
          <a href="/show">
            <strong>Show</strong>
          </a>
          <a href="/ask">
            <strong>Ask</strong>
          </a>
          <a href="/job">
            <strong>Jobs</strong>
          </a>
          <a class="github" href="http://github.com/solidjs/solid" target="_blank" rel="noreferrer">
            Built with Solid
          </a>
        </nav>
      </header>
    );
  };
});

export const App = $component(function* () {
  return function* () {
    return (
      <Router>
        {props => (
          <>
            <Loading fallback={<div class="news-list-nav">Loading...</div>}>
              <Nav />
            </Loading>
            <Loading fallback={<div class="news-list-nav">Loading...</div>}>
              {props.children}
            </Loading>
          </>
        )}
      </Router>
    );
  };
});
