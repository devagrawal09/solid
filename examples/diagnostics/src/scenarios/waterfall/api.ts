/**
 * Scenario 3, file A — the fake service.
 *
 * Every endpoint costs one round trip. Two families exist on purpose:
 *
 * - lookups keyed by what the *previous* response told you (`fetchAuthor`,
 *   `fetchAvatar`) — the shape that invites a chain;
 * - lookups keyed by what the *caller already has* (`fetchAuthorOfStory`,
 *   `fetchAvatarOfStory`) — the shape that lets the three requests leave at
 *   the same time.
 *
 * Latency is configurable so the tests can run the same code faster than the
 * demo does.
 */
export interface Story {
  id: number;
  title: string;
  authorId: number;
  blurb: string;
}

export interface Author {
  id: number;
  name: string;
  avatarId: number;
}

const STORIES: Story[] = [
  { id: 1, title: "Fine-grained rendering, ten years on", authorId: 11, blurb: "A retrospective." },
  { id: 2, title: "Async is a graph problem", authorId: 12, blurb: "Holds, not spinners." },
  { id: 3, title: "What the compiler cannot see", authorId: 13, blurb: "Runtime evidence." }
];

const AUTHORS: Author[] = [
  { id: 11, name: "R. Carniato", avatarId: 101 },
  { id: 12, name: "M. Lambert", avatarId: 102 },
  { id: 13, name: "J. Alvarez", avatarId: 103 }
];

const AVATARS: Record<number, string> = { 101: "🦊", 102: "🐢", 103: "🦉" };

let latencyMs = 220;

/** The demo uses 220ms per hop; tests dial it down. */
export function setLatency(ms: number): void {
  latencyMs = ms;
}

export function latency(): number {
  return latencyMs;
}

let requests = 0;
export function requestCount(): number {
  return requests;
}
export function resetRequestCount(): void {
  requests = 0;
}

function roundTrip<T>(value: T): Promise<T> {
  requests += 1;
  return new Promise(resolve => setTimeout(() => resolve(value), latencyMs));
}

const story = (id: number) => STORIES.find(s => s.id === id) ?? STORIES[0];
const author = (id: number) => AUTHORS.find(a => a.id === id) ?? AUTHORS[0];

export const fetchStory = (id: number): Promise<Story> => roundTrip(story(id));

/** Needs an author id — which only the story response carries. */
export const fetchAuthor = (authorId: number): Promise<Author> => roundTrip(author(authorId));

/** Needs an avatar id — which only the author response carries. */
export const fetchAvatar = (avatarId: number): Promise<string> =>
  roundTrip(AVATARS[avatarId] ?? "❓");

/** Same answer, keyed by the story id the caller already has. */
export const fetchAuthorOfStory = (id: number): Promise<Author> =>
  roundTrip(author(story(id).authorId));

export const fetchAvatarOfStory = (id: number): Promise<string> =>
  roundTrip(AVATARS[author(story(id).authorId).avatarId] ?? "❓");
