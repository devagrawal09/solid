---
"@solidjs/signals": patch
---

Fix scheduler heap corruption when a zombie (a child of a re-running owner) is pulled by an outside reader while it holds a heap entry. `updateIfNecessary` clears the node's zombie flag; it now also moves the heap entry from the zombie heap to the dirty heap, so the flag keeps naming the heap the node is linked in. Before, the commit unlinked the node from the wrong heap: a dirty bucket was cleared or re-tailed and the zombie heap kept a dangling disposed node (a `TypeError` in `deleteFromHeap` after enough programs in one runtime).
