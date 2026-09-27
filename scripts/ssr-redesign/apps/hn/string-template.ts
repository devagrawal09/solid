// Stand-in for what a compiler can emit for an INERT region on the server:
// the Story / Comment views as plain string concatenation — no owner, no
// hole thunks, no hydration ids, no serialization, no `<!--$-->` markers (no
// client code will ever insert there). Toggle instances are islands, so
// their markup keeps the island anchor (`data-i`), exactly as P1-static's.
// Escaping matches the runtime's `escape` (text: & <; attributes: & ").
import type {
  CommentDefinition,
  StoryDefinition
} from "../../../../examples/hackernews-spa/src/types";

const text = (s: unknown) =>
  s == null || s === false ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const attr = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function comment(c: CommentDefinition): string {
  let out = `<li class="comment"><div class="by"><a href="/users/${attr(c.user)}">${text(c.user)}</a> ${text(c.time_ago)} ago</div><div class="text">${c.content ?? ""}</div>`;
  if (c.comments.length) {
    out += `<div data-i="t" class="toggle open"><a>[-]</a></div><ul class="comment-children" style="display:block">`;
    for (const r of c.comments) out += comment(r);
    out += `</ul>`;
  }
  return out + `</li>`;
}

export function storyHTML(s: StoryDefinition): string {
  let out = `<div class="item-view"><div class="item-view-header"><a href="${attr(s.url)}" target="_blank"><h1>${text(s.title)}</h1></a>`;
  if (s.domain) out += `<span class="host">(${text(s.domain)})</span>`;
  out += `<p class="meta">${text(s.points)} points | by <a href="/users/${attr(s.user)}">${text(s.user)}</a> ${text(s.time_ago)} ago</p></div>`;
  out += `<div class="item-view-comments"><p class="item-view-comments-header">${s.comments_count ? s.comments_count + " comments" : "No comments yet."}</p><ul class="comment-children">`;
  for (const c of s.comments) out += comment(c);
  return out + `</ul></div></div>`;
}
