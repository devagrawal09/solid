"use server";

// Registered server action: its wire id is the link fact the resumable
// handler captures. The client stub calls it by id; the test intercepts.
export async function track(sku: string, step: number, detail: unknown) {
  return { sku, step, detail };
}
