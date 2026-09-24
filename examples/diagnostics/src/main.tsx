import { render } from "@solidjs/web";
import { OBSERVE } from "solid-js";
import { installDiagnosticsBridge } from "@solidjs/diagnostics/browser";
import { App } from "./app";
import "./app.css";

// The page half of the agent harness: exposes `__SOLID_DIAGNOSTICS__` so an
// out-of-process driver (Playwright, an agent loop) can open a capture
// session around a scripted interaction and get the same artifact the tests
// assert on. No-op on a production build, where `OBSERVE` is undefined.
if (OBSERVE) installDiagnosticsBridge();

render(() => <App />, document.getElementById("root")!);
