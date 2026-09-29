// The client side of the app (examples/notes's App, as blocks). Compare with
// the React demo's App.server.js: the same composition, but the shell's
// markup lives in server/App.tsx and this file only fills its client
// positions — the notes list (a server component of its own, keyed by the
// search param) and the route outlet. The search field's markup is server
// chrome; searchField() contributes only behavior props. Nothing here
// fetches data; every read goes through a `dynamic()` over a
// server-component query.
//
// What the library's rules change: `App` and `Shell` are `$component`s whose
// SETUPS create the `dynamic()`s and the router's tree (created in a view,
// they would be re-created whenever the view re-rendered). The router's
// render callback renders `Shell`, which takes the location as a prop.
import { createRouter, type RouteSectionProps } from "@solidjs/router";
import {
  $component,
  $snapshot,
  accessor,
  Loading,
  type Element,
  type TypedProps
} from "@solidjs/blocks";
import { dynamic } from "@solidjs/web";
import { appView } from "~/server/App";
import { getNoteList } from "~/lib/api";
import searchField from "~/components/searchField";
import SidebarNoteContent from "~/components/SidebarNoteContent";
import { preload, routes } from "~/routes";
import "./app.css";

const Router = createRouter({ routes, preload });

const App = $component(function* App() {
  // Static chrome: rendered inline at t=0, adopted by the client, never
  // refetched (no reactive input).
  const AppShell = dynamic(() => appView());
  const rendered = (
    <Router>
      {props => (
        <Shell AppShell={AppShell} location={props.location}>
          {props.children}
        </Shell>
      )}
    </Router>
  );
  return function* () {
    return rendered;
  };
});

type AppShellComponent = ReturnType<typeof dynamic<Awaited<ReturnType<typeof appView>>>>;

const Shell = $component(function* Shell(
  props: TypedProps<
    {
      AppShell: AppShellComponent;
      location: RouteSectionProps["location"];
      children: Element;
    },
    "Shell"
  >
) {
  // The list refetches when the search param changes — and morphs in place
  // when a mutation's single-flight response includes it.
  const searchText = accessor(props.location.query.searchText);
  const NoteList = dynamic(() => getNoteList(String(searchText() || "")));
  const search = searchField();
  const AppShell = yield* $snapshot(props.AppShell);
  return function* () {
    return (
      <Loading fallback={<div class="main">Loading...</div>}>
        <AppShell
          {...search}
          noteList={
            <Loading fallback="Loading Notes..">
              <NoteList item={p => <SidebarNoteContent {...p} />} />
            </Loading>
          }
        >
          <Loading fallback="Loading Content">{yield* props.children}</Loading>
        </AppShell>
      </Loading>
    );
  };
});

export default App;
