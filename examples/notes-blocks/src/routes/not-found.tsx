import { useNavigate } from "@solidjs/router";
import { $component } from "@solidjs/blocks";

// Redirects home when created (the original navigates from its body).
const NotFound = $component(function* NotFound() {
  useNavigate()("/", { replace: true });
  return function* () {
    return null;
  };
});

export default NotFound;
