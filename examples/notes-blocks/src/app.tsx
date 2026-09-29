// v2 twin note: `App` is a `$component` that creates `<Router>` in its SETUP
// (as ../hackernews-blocks does): created in the view, the router's client
// navigation to a new route never completes. The router's render callback
// stays a plain callback — `searchField()` reads router context there, and
// the per-render `dynamic()` is keyed by `props.location`.
// The client side of the app. Compare with the React demo's App.server.js:
// the same composition, but the shell's markup lives in server/App.tsx and
// this file only fills its client positions — the notes list (a server
// component of its own, keyed by the search param) and the route outlet.
// The search field isn't a client position anymore: its markup is server
// chrome, and searchField() contributes only behavior props (Stage 6 —
// event props resolve through the frame at dispatch, ref props hand the
// client the elements at adoption). Nothing here fetches data; every read
// goes through a `dynamic()` over a server-component query. Links (the
// New/Edit buttons) aren't client positions at all: the router intercepts
// plain anchors, so they render entirely on the server.
import { createRouter } from "@solidjs/router";
import { $component, Loading } from "solid-js";
import { dynamic } from "@solidjs/web";
import { appView } from "~/server/App";
import { getNoteList } from "~/lib/api";
import searchField from "~/components/searchField";
import SidebarNoteContent from "~/components/SidebarNoteContent";
import { preload, routes } from "~/routes";
import "./app.css";

const Router = createRouter({ routes, preload });

const App = $component(function* () {
  // Static chrome: rendered inline at t=0, adopted by the client, never
  // refetched (no reactive input).
  const AppShell = dynamic(() => appView());
  const rendered = (
    <Router>
      {props => {
        // The list refetches when the search param changes — and morphs in
        // place when a mutation's single-flight response includes it.
        const NoteList = dynamic(() => getNoteList(String(props.location.query.searchText || "")));
        return (
          <Loading fallback={<div class="main">Loading...</div>}>
            <AppShell
              {...searchField()}
              noteList={
                <Loading fallback="Loading Notes..">
                  <NoteList item={p => <SidebarNoteContent {...p} />} />
                </Loading>
              }
            >
              <Loading fallback="Loading Content">{props.children}</Loading>
            </AppShell>
          </Loading>
        );
      }}
    </Router>
  );
  return function* () {
    return rendered;
  };
});

export default App;
