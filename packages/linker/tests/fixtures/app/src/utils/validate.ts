import { normalize } from "./cycle-a";

export class ValidationError extends Error {}

export function validate(title: string) {
  const value = normalize(title);
  if (!value) throw new ValidationError("empty title");
  return value;
}
