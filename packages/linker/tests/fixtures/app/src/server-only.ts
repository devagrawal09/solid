export const audits: string[] = [];
export function audit(what: string) {
  audits.push(what);
}
