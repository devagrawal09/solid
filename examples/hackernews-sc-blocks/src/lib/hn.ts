"use server";
// The HN data source, server-only — the same module as ../../../hackernews
// (the one `"use server"` in this app: data functions, never markup). The
// compiler reads the directive: a call of these functions whose readers are
// inert becomes a frame, a server component the compiler derives.
import type { StoryDefinition, StoryTypes, UserDefinition } from "../types";
import cachedStory from "../../../hackernews/src/lib/story-30186326.json";

const story = (path: string) => `https://node-hnapi.herokuapp.com/${path}`;
const user = (path: string) => `https://hacker-news.firebaseio.com/v0/${path}.json`;

/**
 * One thread is served from a capture instead of the network: 30186326
 * (1,406 comments, 14 levels deep), the scale case both HN apps are
 * measured on. Every other story goes to the network.
 */
const CACHED_STORY_ID = String(cachedStory.id);

const mapStories = {
  top: "news",
  new: "newest",
  show: "show",
  ask: "ask",
  job: "jobs"
} as const;

async function fetchAPI(path: string) {
  const url = path.startsWith("user") ? user(path) : story(path);
  const response = await fetch(url, { headers: { "User-Agent": "chrome" } });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`Received from API: ${text}`);
    return { error: e };
  }
}

export async function getStories(type: StoryTypes, page: number): Promise<StoryDefinition[]> {
  const storyType = mapStories[type];
  if (!storyType) return [];
  return fetchAPI(`${storyType}?page=${page}`);
}

export async function getStory(id: string): Promise<StoryDefinition> {
  if (id === CACHED_STORY_ID) return cachedStory as unknown as StoryDefinition;
  return fetchAPI(`item/${id}`);
}

export async function getUser(id: string): Promise<UserDefinition> {
  return fetchAPI(`user/${id}`);
}
