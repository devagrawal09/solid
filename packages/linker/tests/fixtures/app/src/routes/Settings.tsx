import { $, createSignal, write } from "solid-js";
import { heavyReport } from "../utils/report";

export default function Settings() {
  const [out, setOut] = createSignal("");
  const run = $(function* () {
    yield* write(setOut, heavyReport(3));
  });
  return $(function* () {
    return (
      <section>
        <button id="report" onClick={run}>
          report
        </button>
        <pre id="report-out">{yield* out}</pre>
      </section>
    );
  });
}
