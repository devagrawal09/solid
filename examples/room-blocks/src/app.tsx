// The app root (examples/room's, as a block): a router over routes.ts,
// under the tab's identity. The router is created in the SETUP and the view
// returns it: a router created inside a view is re-created when the view
// re-renders, and client navigation then never completes.
import { createRouter } from "@solidjs/router";
import { $component, Loading, view } from "@solidjs/blocks";
import { IdentityProvider } from "~/lib/identity";
import { routes } from "~/routes";
import "./app.css";

const Router = createRouter({ routes });

const App = $component(function* App() {
  const rendered = (
    <IdentityProvider>
      <Router>
        {props => (
          <Loading fallback={<div class="room muted">Loading…</div>}>{props.children}</Loading>
        )}
      </Router>
    </IdentityProvider>
  );
  return view(function* () {
    return rendered;
  });
});

export default App;
