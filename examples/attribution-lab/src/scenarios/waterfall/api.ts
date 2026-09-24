/**
 * Scenario 3 model — a fake directory service.
 *
 * Two shapes of the same three facts:
 *
 *   `fetchOrg` / `fetchTeam` / `fetchLead`   — each needs an id the PREVIOUS
 *   response carried, so a client that calls them in order is serialised by
 *   the API's own shape.
 *
 *   `fetchTeamByOrg` / `fetchLeadByOrg`      — the same records, addressable
 *   from the org id alone. Every real backend grows these once somebody
 *   measures the waterfall; the fixed variant is what using them looks like.
 *
 * `latency` is a parameter so the app can demonstrate at human scale (150ms)
 * and the tests can run the identical code at 15ms.
 */
export interface Org {
  id: number;
  name: string;
  teamId: string;
}
export interface Team {
  id: string;
  name: string;
  leadId: string;
}
export interface Lead {
  id: string;
  name: string;
  title: string;
}

const ORG_NAMES = ["Acme Robotics", "Northwind Optics", "Initech Analytics"];
const TEAM_NAMES = ["Platform", "Perception", "Runtime"];
const LEAD_NAMES = ["Ada Lovelace", "Grace Hopper", "Barbara Liskov"];

const pick = <T>(list: readonly T[], id: number): T => list[(id - 1) % list.length];

function later<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
}

const orgOf = (id: number): Org => ({ id, name: pick(ORG_NAMES, id), teamId: `team-${id}` });
const teamOf = (id: number): Team => ({
  id: `team-${id}`,
  name: pick(TEAM_NAMES, id),
  leadId: `lead-${id}`
});
const leadOf = (id: number): Lead => ({
  id: `lead-${id}`,
  name: pick(LEAD_NAMES, id),
  title: "Engineering lead"
});

const idOf = (ref: string): number => Number(ref.slice(ref.indexOf("-") + 1));

export interface DirectoryApi {
  /** Sequential trio — each id comes out of the previous response. */
  fetchOrg(id: number): Promise<Org>;
  fetchTeam(teamId: string): Promise<Team>;
  fetchLead(leadId: string): Promise<Lead>;
  /** Parallel-capable pair — addressable from the org id the user already has. */
  fetchTeamByOrg(id: number): Promise<Team>;
  fetchLeadByOrg(id: number): Promise<Lead>;
}

export function createDirectoryApi(latency: number): DirectoryApi {
  return {
    fetchOrg: id => later(latency, orgOf(id)),
    fetchTeam: teamId => later(latency, teamOf(idOf(teamId))),
    fetchLead: leadId => later(latency, leadOf(idOf(leadId))),
    fetchTeamByOrg: id => later(latency, teamOf(id)),
    fetchLeadByOrg: id => later(latency, leadOf(id))
  };
}

export const APP_LATENCY_MS = 150;
