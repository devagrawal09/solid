/**
 * @jsxImportSource @solidjs/web
 */
import { describe, expect, it } from "vitest";
import { children, createMemo, createProjection, merge } from "solid-js";
import { Loading } from "@solidjs/web";

const asyncValue = <T,>(value: T, ms = 10): Promise<T> =>
  new Promise(r => setTimeout(() => r(value), ms));
// Direct source imports while frames are pre-facade: the pnpm override links
// @dom-expressions/runtime to the sibling frame-streams branch, and this
// config's rxcore alias points its internals at solid-web's core — so this
// exercises the slot proxy under Solid's real SSR compile + reactive
// core, which is exactly the integration question.
import { renderServerComponent } from "@dom-expressions/runtime/src/frame-sink.js";
import { createJSONDataTable } from "@dom-expressions/runtime/src/serializer.js";

const collect = (stream: any): Promise<any[]> => stream;

describe("server components authored with Solid JSX", () => {
  it("emits a direct-insert marker for {props.children} through the SSR compile", async () => {
    const ServerComp = (props: any) => (
      <section>
        <h1>Story</h1>
        {props.children}
      </section>
    );
    const chunks = await collect(renderServerComponent(ServerComp, { frame: { id: "f0" } }));
    const html = chunks.find(c => c.type === "html").html;
    expect(html).toContain("<h1>Story</h1>");
    expect(html).toContain("<!--slot:children:start--><!--slot:children:end-->");
    expect(chunks.filter(c => c.type === "slot")).toEqual([]);
  });

  it("treats a prop used in component position as a render-prop slot", async () => {
    // The natural Solid authoring for a client slot with args: SSR
    // compiles component-position props to direct calls, which is exactly
    // the proxy's render-prop shape.
    const ServerComp = (props: any) => (
      <ul>
        {["a", "b"].map((label, i) => (
          <props.comment label={label} meta={{ i }} />
        ))}
      </ul>
    );
    const chunks = await collect(renderServerComponent(ServerComp, { frame: { id: "f1" } }));
    const slots = chunks.filter(c => c.type === "slot");
    expect(slots.map(c => c.key)).toEqual(["comment#0", "comment#1"]);
    expect(slots[0].args.label).toBe("a");
    const table = createJSONDataTable();
    for (const c of chunks.filter(x => x.type === "data")) table.apply(c);
    expect(table.resolve(slots[1].args.meta)).toEqual({ i: 1 });
    const html = chunks.find(c => c.type === "html").html;
    expect(html).toContain("<!--slot:comment#0:start--><!--slot:comment#0:end-->");
    expect(html).toContain("<!--slot:comment#1:start--><!--slot:comment#1:end-->");
  });

  it("streams a createProjection slot arg as one snapshot followed by patch batches", async () => {
    const ServerComp = (props: any) => {
      const state = createProjection(
        async function* (draft: { items: string[] }) {
          draft.items.push("First");
          yield;
          draft.items.push("Second");
          yield;
        },
        { items: [] }
      );
      return <props.content state={state} />;
    };

    const chunks = await collect(
      renderServerComponent(ServerComp, { frame: { id: "projection-slot" } })
    );
    expect(chunks.filter(c => c.type === "error")).toEqual([]);

    const slot = chunks.find(c => c.type === "slot");
    const table = createJSONDataTable();
    for (const chunk of chunks.filter(c => c.type === "data")) table.apply(chunk);

    const transport = table.resolve(slot.args.state);
    expect(transport.type).toBe("solid-async-reactive");
    expect(transport.kind).toBe("projection");
    const values: any[] = [];
    for await (const value of transport.source) values.push(value);
    expect(values[0]).toEqual({ items: ["First"] });
    expect(values[1]).toEqual([
      [["items", "1"], "Second"],
      [["items", "length"], 2]
    ]);
  });

  it("streams every async-generator memo value passed to a slot", async () => {
    const ServerComp = (props: any) => {
      const value = createMemo(async function* () {
        yield "First";
        yield "Second";
      });
      return <props.content value={value} />;
    };

    const chunks = await collect(renderServerComponent(ServerComp, { frame: { id: "memo-slot" } }));
    expect(chunks.filter(c => c.type === "error")).toEqual([]);

    const slot = chunks.find(c => c.type === "slot");
    const table = createJSONDataTable();
    for (const chunk of chunks.filter(c => c.type === "data")) table.apply(chunk);

    const transport = table.resolve(slot.args.value);
    expect(transport.type).toBe("solid-async-reactive");
    expect(transport.kind).toBe("memo");
    const values: any[] = [];
    for await (const value of transport.source) values.push(value);
    expect(values).toEqual(["First", "Second"]);
  });

  it("resolves slot ranges through merge() — props win, defaults never mask positions", async () => {
    const ServerComp = (_props: any) => {
      const props = merge({ header: () => "default" }, _props);
      return (
        <section>
          {props.header}
          <props.row label="a" />
        </section>
      );
    };
    const chunks = await collect(renderServerComponent(ServerComp, { frame: { id: "f3" } }));
    const html = chunks.find(c => c.type === "html").html;
    // The slot proxy's `has: true` routes merge down its proxy path
    // and wins per-property resolution: both the child read and the
    // component-position call reach the slot proxy, not the default.
    expect(html).toContain("<!--slot:header:start--><!--slot:header:end-->");
    expect(html).toContain("<!--slot:row#0:start--><!--slot:row#0:end-->");
    expect(html).not.toContain("default");
    const slots = chunks.filter(c => c.type === "slot");
    expect(slots.map(c => c.key)).toEqual(["row#0"]);
  });

  it("does not become thenable under merge/await plumbing", async () => {
    const ServerComp = (props: any) => {
      // A stray Promise.resolve(props) must not invoke a phantom `then` slot.
      void Promise.resolve(props);
      return <div>ok</div>;
    };
    const chunks = await collect(renderServerComponent(ServerComp, { frame: { id: "f4" } }));
    expect(chunks.filter(c => c.type === "slot")).toEqual([]);
    expect(chunks.find(c => c.type === "html").html).toMatch(/^<div( _hk=\d+)?>ok<\/div>$/);
  });

  it("streams a real <Loading> boundary as fragment + reveal chunks, slot ranges inside", async () => {
    const ServerComp = (props: any) => {
      const data = createMemo(async () => asyncValue("Comments loaded", 10));
      return (
        <article>
          <h1>Story</h1>
          <Loading fallback={<span>loading…</span>}>
            <section>
              {data()}
              {props.children}
            </section>
          </Loading>
        </article>
      );
    };
    const chunks = await collect(renderServerComponent(ServerComp, { frame: { id: "s" } }));
    const html = chunks.find(c => c.type === "html").html;
    // Shell flushes with the boundary's placeholder range, fallback in the
    // template — Solid's Loading drives registerFragment through the sink.
    expect(html).toContain("<h1>Story</h1>");
    expect(html).toMatch(/<template id="pl-[^"]+">.*loading…/);
    expect(html).not.toContain("Comments loaded");
    const frag = chunks.find(c => c.type === "fragment");
    expect(frag.html).toContain("Comments loaded");
    // The thread-through case: a slot declared inside streamed async
    // content — the client slot mounts when the fragment reveals.
    expect(frag.html).toContain("<!--slot:children:start--><!--slot:children:end-->");
    const reveal = chunks.find(c => c.type === "reveal");
    expect(reveal.keys).toEqual([frag.key]);
    expect(chunks[chunks.length - 1].type).toBe("complete");
  });

  it("survives the children() helper", async () => {
    const ServerComp = (props: any) => {
      const resolved = children(() => props.children);
      return <div>{resolved()}</div>;
    };
    const chunks = await collect(renderServerComponent(ServerComp, { frame: { id: "f2" } }));
    const html = chunks.find(c => c.type === "html").html;
    // The hydratable compile allocates a hydration key around the children()
    // memo — expected; the slot range itself is intact.
    expect(html).toMatch(
      /^<div( _hk=\d+)?><!--slot:children:start--><!--slot:children:end--><\/div>$/
    );
  });
});
