/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// The demo's SearchField.client.js, dissolved (Stage 6). The search field's
// MARKUP lives in the server shell (server/App.tsx); what remains here is
// pure behavior — a bag of functions the client hands the server component:
//
// - `onSearch`/`onSubmit` are event props: the server marks the elements,
//   and the document-level delegation walk resolves them through the
//   frame's live props at dispatch time.
// - `searchInput`/`spinner` are ref props: they fire with the adopted
//   elements, and the effects below sync that server-rendered DOM against
//   the router's state (the input restores `?searchText` on deep links and
//   back/forward; the spinner tracks the pending navigation).
//
// A word on fit, because this file shows the PATTERN'S BOUNDARY as much as
// the pattern. Event props and one-way refs (the spinner) are the sweet
// spot: behavior on chrome you'd never ship a component for — and in chat's
// copy buttons, on markup the client couldn't author at all. The input's
// value-sync effect below is the edge: once an element's STATE must track
// client reactivity, a ref means hand-writing the binding that JSX's
// `value={...}` gives a client component for free. We keep the input server
// chrome here because one small effect is a fair trade for dissolving the
// shell's last hydration island — but when an element is mostly client
// state, make it a client position and let JSX do the syncing.
//
// Search state itself is unchanged: the `?searchText` query param, so typing
// navigates — the router reruns the root preload and the notes-list server
// component refetches, morphing the list boundary in place.
//
// What the library's rules change: it is a generator helper the app shell's
// setup delegates to (`yield* searchField(props.location)`). It reads the
// route's location with `yield*` — never the router's own reactive hooks —
// the event props are `$event`s, and the effects are `$effect`s created in
// the setup: they keep the latest values, and the ref props (which fire
// later, at adoption) only hand over the element and apply them.
import { useNavigate, type RouteSectionProps } from "@solidjs/router";
import { $effect, $event, isPendingOf, type TypedProps } from "@solidjs/blocks";

type Location = TypedProps<{ location: RouteSectionProps["location"] }>["location"];

export default function* searchField(location: Location) {
  const navigate = useNavigate();
  let input: HTMLInputElement | undefined;
  let spinner: HTMLElement | undefined;
  let text = "";
  let searching = false;
  const syncInput = () => {
    if (input) input.value = text;
  };
  const syncSpinner = () => {
    if (!spinner) return;
    spinner.classList.toggle("spinner--active", searching);
    spinner.setAttribute("aria-busy", String(searching));
  };
  yield* $effect(function* () {
    text = String((yield* location.query.searchText) || "");
    syncInput();
  });
  yield* $effect(function* () {
    searching = yield* isPendingOf(location.query.searchText);
    syncSpinner();
  });
  return {
    onSearch: $event(function* (e: InputEvent) {
      const value = (e.target as HTMLInputElement).value;
      const params = new URLSearchParams(yield* location.search);
      if (value) params.set("searchText", value);
      else params.delete("searchText");
      const query = params.toString();
      navigate((yield* location.pathname) + (query ? `?${query}` : "") + (yield* location.hash), {
        scroll: false,
        resolve: false
      });
    }),
    onSubmit: $event(function* (e: SubmitEvent) {
      e.preventDefault();
    }),
    searchInput: (el: HTMLInputElement) => {
      input = el;
      syncInput();
    },
    spinner: (el: HTMLElement) => {
      spinner = el;
      syncSpinner();
    }
  };
}
