import { $, createMemo, createSignal } from "solid-js";

const [userId] = createSignal(1);
const [locale] = createSignal("en");

// Reads before the first `await` are the memo's dependencies; after it the
// callback only uses plain values (the loaded result, locals, helpers).
export const user = createMemo(
  $(async () => {
    const id = userId();
    const lang = locale();
    const loaded = await fetchUser(id);
    const name = formatName(loaded, lang);
    return { id, name, greeting: `Hello ${name}` };
  })
);

declare function fetchUser(id: number): Promise<{ first: string; last: string }>;
declare function formatName(user: { first: string; last: string }, locale: string): string;
