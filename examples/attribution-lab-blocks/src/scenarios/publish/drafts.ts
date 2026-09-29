/**
 * Scenario 4 model — publishing three drafts, one of which the server
 * rejects.
 *
 * Both variants end in exactly the same state: status `done`, progress 3/3,
 * two published, "Draft B" skipped. Nothing is broken in the sense of a wrong
 * value — which is the point. The difference is entirely one of provenance:
 *
 *   broken — the loop `await`s and then writes. `await` resumes on a plain
 *            microtask with no reactive frame on the stack, so the writes
 *            escape the action's transaction: the engine stamps them
 *            `{ kind: "external" }` and the trail from the click is lost.
 *            Each write also commits on its own instead of with the step.
 *
 *   fixed  — the loop `yield`s after the `await` before writing. `yield`
 *            hands control back to the action runner, which re-enters the
 *            transaction; every write is stamped `{ kind: "action", name:
 *            "publish", interaction: { … click … } }`.
 *
 * This is the documented `await`-vs-`yield` escape, and it is the class of
 * defect no type system and no compiler can see: both programs type-check,
 * both produce the right answer, and only the attribution record separates
 * them.
 */
import { action, createSignal, type Accessor } from "solid-js";
import type { Variant } from "../../lab/engine";

export interface Draft {
  id: string;
  title: string;
}

export const DRAFTS: readonly Draft[] = [
  { id: "a", title: "Draft A" },
  { id: "b", title: "Draft B" },
  { id: "c", title: "Draft C" }
];

/** The server rejects "Draft B" — the interesting half of the end state. */
function upload(draft: Draft, latency: number): Promise<{ ok: boolean }> {
  return new Promise(resolve => setTimeout(() => resolve({ ok: draft.id !== "b" }), latency));
}

export type PublishStatus = "idle" | "publishing" | "done";

export interface Publisher {
  status: Accessor<PublishStatus>;
  progress: Accessor<number>;
  published: Accessor<string[]>;
  skipped: Accessor<string[]>;
  publish(drafts: readonly Draft[]): Promise<void>;
}

export const PUBLISH_LATENCY_MS = 60;

export function createPublisher(variant: Variant, latency = PUBLISH_LATENCY_MS): Publisher {
  const [status, setStatus] = createSignal<PublishStatus>("idle", { name: "status" });
  const [progress, setProgress] = createSignal(0, { name: "progress" });
  const [published, setPublished] = createSignal<string[]>([], { name: "published" });
  const [skipped, setSkipped] = createSignal<string[]>([], { name: "skipped" });

  // The generator's own name is what the engine reports as the action name
  // (`genFn.name`), so the binding it is assigned to must NOT share that name:
  // a same-named local in scope makes bundlers rename the function expression
  // (`publish` → `publish2`) and the report would show the mangled name.
  const publishAction = action(async function* publish(drafts: readonly Draft[]) {
    // This first slice runs synchronously inside the click, so it is stamped
    // with the action AND the interaction in both variants.
    setStatus("publishing");
    setProgress(0);
    setPublished([]);
    setSkipped([]);

    for (const draft of drafts) {
      const result = await upload(draft, latency);
      // ── the difference ────────────────────────────────────────────────
      if (variant === "fixed") yield; // re-enter the transaction before writing
      if (result.ok) setPublished(list => [...list, draft.title]);
      else setSkipped(list => [...list, draft.title]);
      setProgress(value => value + 1);
    }

    setStatus("done");
  });

  return { status, progress, published, skipped, publish: publishAction };
}
