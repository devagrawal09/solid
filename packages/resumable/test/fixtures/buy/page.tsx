import { Errored } from "solid-js";
import { Buy } from "./buy";

// The page is ordinary server-rendered Solid: it is not a resumable scope
// (it renders components). Its boundary is the coordinate a resumed handler
// failure inside `Buy` routes to.
export function Page(props: { skus: string[] }) {
  return (
    <main class="page">
      <Errored fallback={() => <p class="fallback">failed</p>}>
        {props.skus.map(sku => (
          <Buy sku={sku} />
        ))}
      </Errored>
      <section class="outside">
        <Buy sku="outside" />
      </section>
    </main>
  );
}
