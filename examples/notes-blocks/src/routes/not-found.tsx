import { useNavigate } from "@solidjs/router";
import { $component } from "solid-js";

// The redirect runs in the setup, as the original's body does; the view
// renders nothing.
const NotFound = $component(function* () {
  useNavigate()("/", { replace: true });
  return function* () {
    return null;
  };
});

export default NotFound;
