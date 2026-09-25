import { Errored, Loading, lazy } from "solid-js";
import { Toolbar } from "./components";
import { LogView } from "./components/LogView";
import { Editor } from "./features/editor";
import { Wrappers } from "./features/wrappers";
import { save } from "./exported-handler";

const Settings = lazy(() => import("./routes/Settings"));

export function App() {
  return (
    <Errored fallback={(error, reset) => <p id="failed">failed: {String(error())}</p>}>
      <Toolbar onSave={save} />
      <LogView />
      <Editor />
      <Wrappers />
      <Loading fallback={<p>loading</p>}>
        <Settings />
      </Loading>
    </Errored>
  );
}
