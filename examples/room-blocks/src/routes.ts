// The route tree, in its own module so both the app root and the
// server-function config can share it. `/` is the room as a live SERVER
// component (markup that keeps changing); `/live` is the same room from
// live DATA sources, rendered in the browser.
import { defineRoute, defineRoutes } from "@solidjs/router";
import type { Component } from "@solidjs/blocks";
import Home from "~/routes/home";
import Live from "~/routes/live";

/**
 * The router is plain Solid: its types do not see a block component's
 * pending / failures. A route renders under the app's <Loading> (app.tsx),
 * so it may be pending; it must handle its own failures.
 */
function route<P>(component: Component<P, boolean, never>): Component<P, boolean, never> {
  return component;
}

export const routes = defineRoutes([
  defineRoute({ path: "/", component: route(Home) }),
  defineRoute({ path: "/live", component: route(Live) })
]);
