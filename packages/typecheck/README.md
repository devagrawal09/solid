# @solidjs/typecheck — `solid-tsc`

`tsc` for projects that use the direct property syntax inside `$` blocks:

```tsx
const summary = createMemo(
  $(function* () {
    const name = yield* store.user.name; // string
    const first = yield* store.items[0].name; // string
    const current = yield* store.items[i]; // Item   (i: number)
    const count = yield* store.items.length; // number
    const n = yield* props.count; // number  (props: a component's first parameter)
    return { name, first, current, count, n };
  })
);
```

Stock TypeScript cannot type these `yield*` operands: it sees a `string` (iterated as characters, result `void`) or a `number` (TS2488). `solid-tsc` is the `tsc` command with a compiler host that hands the checker a _projection_ of every module that imports `$` from `solid-js` / `@solidjs/signals`:

```tsx
// authored                       // what the checker sees
yield * store.items[i].name;
yield * __solid_readPath(store, ["items", i, "name"], store.items[i].name);
yield * props.count;
yield * __solid_readProp(props, ["count"], props.count);
```

- `readPath` / `readProp` are the operations the native compiler lowers the same spelling to, typed `StoreRead<Root, Path>` / `PropRead<Root, Path>`; the selected value is `PathValue<Root, Path>` and a block's `BlockReads` records the root plus the static path. A value that is itself readable — a signal accessor or a block held in a prop or a store field — is read through, as `yield*` does on the value: `yield* props.filter` with `filter: SourceAccessor<Filter>` is a `Filter` (`PathResult<Root, Path>`), and the accessor's own async/error coloring is inherited.
- The third argument is the authored operand kept verbatim, so TypeScript reports a wrong key (`store.user.nope` → TS2339) or a bad index at its authored column.
- Every projection edit is an insertion; all other positions survive and diagnostics are mapped back to authored lines and columns. Declarations are emitted from the projected program, so a published `.d.ts` contains ordinary `StoreRead<…>` / `PropRead<…>` types and downstream consumers need no projection.

## Usage

```bash
solid-tsc -p tsconfig.json            # check (and emit, unless noEmit)
solid-tsc -p tsconfig.json --noEmit
```

Any single-project `tsc` argument list is accepted (`-p/--project`, `--noEmit`, `--declaration`, `--outDir`, …). Programmatically:

```js
import { check, formatDiagnostics } from "@solidjs/typecheck";
const { diagnostics, emitSkipped } = check({ project: "tsconfig.json" });
console.log(formatDiagnostics(diagnostics));
```

Not supported: `--build` / `-b` (project references in build mode) and `--watch`. Run each project through `solid-tsc -p`, consumers after their dependencies have emitted declarations — the emitted `.d.ts` files carry the block types, so separate compilation works.

## What is projected

The forms the native compiler lowers as paths, and only those: a `yield*` operand that is a member chain on an identifier root with static keys (`.name`, `["name"]`), numeric indices (`[0]`), `.length`, and bare-identifier keys (`[i]`, typed by `i`). Roots are recorded as written: an alias (`const u = store.user; yield* u.name`) is its own root of its own type; a destructured field is a plain value and not a read. A root that is the first parameter of a capitalized function is a component's props (`PropRead`); everything else is `StoreRead`.

Left as written (TypeScript's own diagnosis of the authored code applies): optional chains (`store.user?.name`), calls (`store.items.filter(...)` — use `yield* readStore(store, s => s.items.filter(...))`), computed keys other than a literal or a bare identifier (`store.items[i + 1]` — bind the index first), `splitProps` / `mergeProps` results (ordinary objects; the compiler lowers reads on them as store paths, which track through their getters). A refused string operand is reported at the block (`TS2769`: the generator yields `string`, so no `$` overload accepts it), a refused non-iterable operand at the operand (`TS2488`).

## Strict `$(fn)` callbacks

A non-generator marker — `createMemo($(() => count() * 2))`, `<button onClick={$(() => setCount(v => v + 1))} />` — is ordinary TypeScript that stock `tsc` types by itself (`$(fn)` is `StrictCallback<Input, R>`). `solid-tsc` additionally runs the compiler's strict analysis (`analyzeStrictBlocks`) over every project file that may hold a marker and reports its diagnostics next to TypeScript's, at authored positions:

```text
src/bad.tsx(10,52): error SOLID90003: [STRICT_CAPABILITY_ESCAPE] `count` is an accessor and is passed to `register`, which has no strict summary; … read its value with `count()` and pass or store that
```

`check()` returns `strictBlocks`, a `Map` from file name to the graph summaries (host, reads, writes, owned creations, unsummarized calls, escapes, `exact` / `bounded` / `unknown` completeness) of that file's marked callbacks. Programmatically, per file:

```js
import { analyzeStrictFile } from "@solidjs/typecheck";
const { blocks, diagnostics } = analyzeStrictFile(fileName, text);
```

`diagnostics` are TypeScript-shaped (`file`, `start`, `length`, `messageText`, `code`, `source: "solid-strict"`) on the authored text, and every `site` in `blocks` is an authored UTF-16 offset with 1-based line/column — the boundary a language-service plugin consumes without any position mapping. The syntax, diagnostics and summary contract are documented in `documentation/plans/strict-solid-tsx.md`.

## Editor limitation

No TypeScript language-service plugin ships yet. Editors run stock `tsc` and still report the authored `yield* store.user.name` as an error (a `string` iterated to `void`, or TS2488 for numbers); the project's `solid-tsc` run is the source of truth. A language-service plugin would apply the same projection to the editor's program; it is not included because a plugin cannot rewrite source text reliably across the LSP surface (completions, renames and quick info would need the same position mapping in reverse).
