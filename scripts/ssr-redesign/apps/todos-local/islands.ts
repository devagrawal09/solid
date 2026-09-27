// todos-local: the activation a compiler would emit for the app's one island
// group (hand-written stand-in; the grouping and tier are analyze.mjs's).
//
// Header, MainSection, TodoItem, Footer and App share `todos` (every handler
// writes it, every view reads it), so they activate together. The group
// needs tier 1: memos (`filtered`, `allCompleted`, `remaining`,
// `completed`), branches (three `Show`s), a keyed list, and cells shared
// across components. It imports the reactive API from "@solidjs/signals";
// the build binds that to the tier-1 kernel or to the full core (tier 2),
// so both tiers run exactly this code.
//
// Compared with hydration it re-runs no component and claims nothing:
// - cells are rebuilt from their own client-evaluable initializers (`todos`
//   from localStorage, `filter` from `location.hash`), as hydration does;
// - nodes are reached by static paths from the island root; the dynamic
//   regions keep their `<!--$-->…<!--/-->` bounds;
// - holes whose inputs are static are not bound: a row's fields come from
//   an immutable item that a keyed row never sees change (a changed item is
//   a new row), so rows bind no effects at all, only delegated handlers;
// - live holes are render effects whose first run writes nothing (the
//   server DOM already shows it).
import {
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  onCleanup,
  untrack
} from "@solidjs/signals";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
}
type Filter = "all" | "active" | "completed";
const parseHash = (hash: string): Filter =>
  hash === "#/active" ? "active" : hash === "#/completed" ? "completed" : "all";

const tpl = (html: string) => {
  const t = document.createElement("template");
  t.innerHTML = html;
  return () => t.content.firstChild!.cloneNode(true) as HTMLElement;
};
const rowTpl = tpl(
  `<li class="todo"><div class="view"><input class="toggle" type="checkbox"><label></label><button class="destroy"></button></div></li>`
);
const mainTpl = tpl(
  `<section class="main"><input id="toggle-all" class="toggle-all" type="checkbox"><label for="toggle-all">Mark all as complete</label><ul class="todo-list"></ul></section>`
);
const footerTpl = tpl(
  `<footer class="footer"><span class="todo-count"><strong></strong> <!--$--><!--/--> left</span><ul class="filters"><li><a href="#/" class="">All</a></li><li><a href="#/active" class="">Active</a></li><li><a href="#/completed" class="">Completed</a></li></ul><!--$--><!--/--></footer>`
);
const clearTpl = tpl(`<button class="clear-completed">Clear completed</button>`);

/** A `Show` region between two markers: `build` fills it (adopting the server node when there is one). */
function show(end: Comment, when: () => boolean, build: (existing: Element | null) => Element) {
  let region: (() => void) | undefined;
  createRenderEffect(when, (on, prev) => {
    if (prev === undefined) {
      const node = end.previousSibling!;
      const existing = node.nodeType === 1 ? (node as Element) : null;
      if (on)
        createRoot(dispose => {
          region = dispose;
          const built = build(existing);
          if (!existing) end.before(built);
        });
      return;
    }
    if (on === prev) return;
    if (on)
      createRoot(dispose => {
        region = dispose;
        end.before(build(null));
      });
    else {
      region!();
      region = undefined;
      const start = findStart(end);
      while (start.nextSibling !== end) start.nextSibling!.remove();
    }
  });
}
function findStart(end: Comment): Comment {
  let n = end.previousSibling;
  while (!(n instanceof Comment && n.data === "$")) n = n!.previousSibling;
  return n as Comment;
}

export function activate(root: HTMLElement) {
  const app = root.firstChild as HTMLElement; // section.todoapp
  // [<!--$--> header <!--/--> <!--$--> main? <!--/--> <!--$--> footer? <!--/-->]
  const [, mainEnd, footerEnd] = ends(app);
  const initial: Todo[] = JSON.parse(localStorage.getItem("TODOS") || "[]");

  createRoot(() => {
    // --- App: cells and the load-time listener ------------------------------------
    const [todos, setTodos] = createSignal(initial);
    const [filter, setFilter] = createSignal(parseHash(location.hash));
    const onHash = () => setFilter(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    onCleanup(() => window.removeEventListener("hashchange", onHash));
    const save = (next: Todo[]) => (localStorage.setItem("TODOS", JSON.stringify(next)), next);
    const addTodo = (title: string) =>
      setTodos(t =>
        save([
          ...t,
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, completed: false }
        ])
      );
    const removeTodo = (id: string) => setTodos(t => save(t.filter(x => x.id !== id)));
    const toggleTodo = (id: string, completed: boolean) =>
      setTodos(t => save(t.map(x => (x.id === id ? { ...x, completed } : x))));
    const toggleAll = (completed: boolean) =>
      setTodos(t => save(t.map(x => (x.completed === completed ? x : { ...x, completed }))));
    const clearCompleted = () => setTodos(t => save(t.filter(x => !x.completed)));

    // --- handlers (delegated; the compiler's handler map) ----------------------------
    const itemOf = new WeakMap<Element, Todo>();
    app.addEventListener("keydown", e => {
      const input = e.target as HTMLInputElement;
      if (!input.matches(".new-todo") || (e as KeyboardEvent).key !== "Enter") return;
      const title = input.value.trim();
      if (!title) return;
      input.value = "";
      addTodo(title);
    });
    app.addEventListener("input", e => {
      const el = e.target as HTMLInputElement;
      if (el.matches(".toggle")) toggleTodo(itemOf.get(el.closest("li")!)!.id, el.checked);
      else if (el.matches(".toggle-all")) toggleAll(!untrack(allCompleted));
    });
    app.addEventListener("click", e => {
      const el = e.target as Element;
      if (el.matches(".destroy")) removeTodo(itemOf.get(el.closest("li")!)!.id);
      else if (el.matches(".clear-completed")) clearCompleted();
    });

    // --- MainSection ----------------------------------------------------------------------
    const filtered = createMemo(() => {
      const f = filter();
      return f === "active"
        ? todos().filter(x => !x.completed)
        : f === "completed"
          ? todos().filter(x => x.completed)
          : todos();
    });
    const allCompleted = createMemo(() => todos().length > 0 && todos().every(x => x.completed));
    show(
      mainEnd,
      () => todos().length > 0,
      existing => {
        const section = existing || mainTpl();
        const toggle = section.firstChild as HTMLInputElement;
        const ul = section.lastChild as HTMLElement;
        createRenderEffect(allCompleted, (v, p) => {
          if (p !== undefined || !existing) toggle.checked = v;
        });
        list(ul, filtered, existing ? (ul.children as unknown as HTMLElement[]) : null);
        return section;
      }
    );

    // --- TodoItem rows: a keyed list; rows bind nothing reactive -------------------------------
    function row(todo: Todo, existing?: HTMLElement) {
      const li = existing || rowTpl();
      if (!existing) {
        if (todo.completed) li.classList.toggle("completed", true);
        (li.firstChild!.firstChild as HTMLInputElement).checked = todo.completed;
        li.firstChild!.firstChild!.nextSibling!.textContent = todo.title;
      }
      itemOf.set(li, todo);
      return li;
    }
    function list(ul: HTMLElement, each: () => Todo[], adopt: HTMLElement[] | null) {
      let rows = new Map<Todo, HTMLElement>();
      createRenderEffect(each, (items, prev) => {
        if (prev === undefined && adopt) {
          const nodes = Array.from(adopt);
          items.forEach((t, i) => rows.set(t, row(t, nodes[i])));
          return;
        }
        const next = new Map<Todo, HTMLElement>();
        for (const t of items) next.set(t, rows.get(t) || row(t));
        for (const [t, li] of rows) if (!next.has(t)) li.remove();
        let cursor = ul.firstChild;
        for (const li of next.values()) {
          if (li === cursor) cursor = cursor.nextSibling;
          else ul.insertBefore(li, cursor);
        }
        rows = next;
      });
    }

    // --- Footer ----------------------------------------------------------------------------
    const remaining = createMemo(() => todos().filter(x => !x.completed).length);
    const completed = createMemo(() => todos().length - remaining());
    show(
      footerEnd,
      () => todos().length > 0,
      existing => {
        const footer = existing || footerTpl();
        const span = footer.firstChild as HTMLElement;
        const strong = span.firstChild as HTMLElement;
        const [wordEnd] = ends(span);
        const links = footer.querySelectorAll("a");
        const fresh = !existing;
        createRenderEffect(remaining, (v, p) => {
          if (p !== undefined || fresh) strong.textContent = String(v);
        });
        createRenderEffect(
          () => (remaining() === 1 ? "item" : "items"),
          (v, p) => {
            if (p === undefined && !fresh) return;
            const start = findStart(wordEnd);
            if (start.nextSibling !== wordEnd) (start.nextSibling as Text).data = v;
            else wordEnd.before(v);
          }
        );
        (["all", "active", "completed"] as const).forEach((f, i) =>
          createRenderEffect(
            () => filter() === f,
            (v, p) => {
              if (p !== undefined || fresh) links[i].classList.toggle("selected", v);
            }
          )
        );
        show(
          footer.lastChild as Comment,
          () => completed() > 0,
          ex => ex || clearTpl()
        );
        return footer;
      }
    );
  });
}
/** The region end markers directly under `parent`, in order. */
function ends(parent: Node): Comment[] {
  const out: Comment[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling)
    if (n.nodeType === 8 && (n as Comment).data === "/") out.push(n as Comment);
  return out;
}
