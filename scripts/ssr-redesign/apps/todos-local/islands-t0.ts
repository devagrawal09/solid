// todos-local, "T0*": the island group with no reactive runtime at all,
// written by hand as direct updates. This is OUTSIDE the tier-0 rule (the
// group has memos, branches, a keyed list and cells shared across
// components), so no compiler following the rules would emit it; it is the
// floor a list-aware tier 0 could reach, to bound what the tier-1 kernel
// costs over hand-written code. Semantics kept: writes are batched and
// applied on a microtask, the DOM after every flush equals the reactive
// versions' (the measure gate checks it).
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
const ends = (parent: Node) => {
  const out: Comment[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling)
    if (n.nodeType === 8 && (n as Comment).data === "/") out.push(n as Comment);
  return out;
};
const elementBefore = (end: Comment) =>
  end.previousSibling!.nodeType === 1 ? (end.previousSibling as HTMLElement) : null;

export function activate(root: HTMLElement) {
  const app = root.firstChild as HTMLElement;
  const [, mainEnd, footerEnd] = ends(app);
  let todos: Todo[] = JSON.parse(localStorage.getItem("TODOS") || "[]");
  let filter = parseHash(location.hash);
  let main = elementBefore(mainEnd);
  let footer = elementBefore(footerEnd);
  let rows = new Map<Todo, HTMLElement>();
  const itemOf = new WeakMap<Element, Todo>();
  if (main) {
    const lis = main.lastChild!.childNodes;
    todos.forEach((t, i) => (rows.set(t, lis[i] as HTMLElement), itemOf.set(lis[i] as Element, t)));
  }
  // rendered values, to write only what changed
  let shownAll = todos.length > 0 && todos.every(x => x.completed);
  let shownRemaining = todos.filter(x => !x.completed).length;
  let shownFilter = filter;

  let scheduled = false;
  const set = (next: Todo[]) => {
    todos = next;
    localStorage.setItem("TODOS", JSON.stringify(next));
    if (!scheduled) ((scheduled = true), queueMicrotask(render));
  };
  window.addEventListener("hashchange", () => {
    filter = parseHash(location.hash);
    if (!scheduled) ((scheduled = true), queueMicrotask(render));
  });

  function row(t: Todo) {
    const li = rowTpl();
    if (t.completed) li.classList.toggle("completed", true);
    (li.firstChild!.firstChild as HTMLInputElement).checked = t.completed;
    li.firstChild!.firstChild!.nextSibling!.textContent = t.title;
    itemOf.set(li, t);
    return li;
  }
  function render() {
    scheduled = false;
    const any = todos.length > 0;
    const allDone = any && todos.every(x => x.completed);
    const remaining = todos.filter(x => !x.completed).length;
    // MainSection
    if (any && !main) {
      main = mainTpl();
      mainEnd.before(main);
      rows = new Map();
      shownAll = !allDone;
    } else if (!any && main) {
      main.remove();
      main = null;
    }
    if (main) {
      if (allDone !== shownAll) (main.firstChild as HTMLInputElement).checked = shownAll = allDone;
      const items =
        filter === "active"
          ? todos.filter(x => !x.completed)
          : filter === "completed"
            ? todos.filter(x => x.completed)
            : todos;
      const ul = main.lastChild as HTMLElement;
      const next = new Map<Todo, HTMLElement>();
      for (const t of items) next.set(t, rows.get(t) || row(t));
      for (const [t, li] of rows) if (!next.has(t)) li.remove();
      let cursor = ul.firstChild;
      for (const li of next.values()) {
        if (li === cursor) cursor = cursor.nextSibling;
        else ul.insertBefore(li, cursor);
      }
      rows = next;
    }
    // Footer
    if (any && !footer) {
      footer = footerTpl();
      footerEnd.before(footer);
      shownRemaining = -1;
      shownFilter = "" as Filter;
    } else if (!any && footer) {
      footer.remove();
      footer = null;
    }
    if (footer) {
      const span = footer.firstChild as HTMLElement;
      if (remaining !== shownRemaining) {
        const word = remaining === 1 ? "item" : "items";
        if (shownRemaining === -1 || (shownRemaining === 1) !== (remaining === 1)) {
          const [wordEnd] = ends(span);
          const prev = wordEnd.previousSibling!;
          if (prev.nodeType === 3) (prev as Text).data = word;
          else wordEnd.before(word);
        }
        (span.firstChild as HTMLElement).textContent = String((shownRemaining = remaining));
      }
      if (filter !== shownFilter) {
        const links = footer.querySelectorAll("a");
        (["all", "active", "completed"] as const).forEach((f, i) =>
          links[i].classList.toggle("selected", f === filter)
        );
        shownFilter = filter;
      }
      const clearEnd = footer.lastChild as Comment;
      const clear = elementBefore(clearEnd);
      const done = todos.length - remaining;
      if (done > 0 && !clear) clearEnd.before(clearTpl());
      else if (done === 0 && clear) clear.remove();
    }
  }

  app.addEventListener("keydown", e => {
    const input = e.target as HTMLInputElement;
    if (!input.matches(".new-todo") || (e as KeyboardEvent).key !== "Enter") return;
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    set([
      ...todos,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, completed: false }
    ]);
  });
  app.addEventListener("input", e => {
    const el = e.target as HTMLInputElement;
    if (el.matches(".toggle")) {
      const id = itemOf.get(el.closest("li")!)!.id;
      set(todos.map(x => (x.id === id ? { ...x, completed: el.checked } : x)));
    } else if (el.matches(".toggle-all")) {
      const completed = !(todos.length > 0 && todos.every(x => x.completed));
      set(todos.map(x => (x.completed === completed ? x : { ...x, completed })));
    }
  });
  app.addEventListener("click", e => {
    const el = e.target as Element;
    if (el.matches(".destroy")) {
      const id = itemOf.get(el.closest("li")!)!.id;
      set(todos.filter(x => x.id !== id));
    } else if (el.matches(".clear-completed")) set(todos.filter(x => !x.completed));
  });
}
