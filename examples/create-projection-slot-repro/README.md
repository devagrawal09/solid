# `createProjection` in a server-component slot

This is a small frame-level repro for passing a streaming server
`createProjection` store to a client slot in a post-load server component.

From a built Solid repository, run:

```sh
node examples/create-projection-slot-repro/repro.mjs
```

On commit `8c8b591661e3`, the frame ends with:

```text
Seroval Error (step: 1)
```

The intended transport is one complete state value after the first projection
yield, followed by the existing store patch batches. The slot would retain one
stable store identity while receiving only later changes.
