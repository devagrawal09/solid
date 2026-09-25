import { $, createSignal, write } from "solid-js";
import { describeSave } from "../utils/describe";
import { heavyReport } from "../utils/report";

export default function Settings() {
  const [out, setOut] = createSignal("");
  const run = $(function* () {
    yield* write(setOut, `${heavyReport(3)}\n${describeSave(0, false)}`);
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
