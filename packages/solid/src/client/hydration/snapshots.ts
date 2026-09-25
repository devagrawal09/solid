// Capability: snapshots — the snapshot/deferred-source setup.
//
// While hydration claims server-rendered DOM, readers inside a snapshot scope
// must see the values the server rendered from, even if a source changes
// mid-pass (a serialized async value landing, a pre-hydration gate flipping,
// a store replay applying). This module only turns the core's snapshot
// capture on and off around hydration passes and boundary resume windows;
// the snapshot read paths themselves live in the reactive core and are not
// removed by omitting this capability.
//
// A client graph needs it whenever anything can change between the start of
// a pass and the claim of its readers: async results, store adapters,
// ssrSource policies, or loading-boundary resumes. A graph with none of
// those (synchronous, no store adapters) can omit it.
import {
  getOwner,
  setSnapshotCapture,
  markSnapshotScope,
  releaseSnapshotScope,
  clearSnapshots,
  type Owner
} from "@solidjs/signals";
import { slots, markInstalled, CAP_SNAPSHOTS, type SnapshotHooks } from "./state.js";

let _snapshotRootOwner: Owner | null = null;

const snapshotHooks: SnapshotHooks = {
  begin() {
    setSnapshotCapture(true);
    _snapshotRootOwner = null;
  },
  markTop() {
    if (_snapshotRootOwner) return;
    let owner: Owner | null = getOwner();
    if (!owner) return;
    while (owner._parent) owner = owner._parent;
    markSnapshotScope(owner);
    _snapshotRootOwner = owner;
  },
  endRoot() {
    if (_snapshotRootOwner) {
      releaseSnapshotScope(_snapshotRootOwner);
      _snapshotRootOwner = null;
    }
  },
  enter(o) {
    markSnapshotScope(o);
    _snapshotRootOwner = o;
  },
  leave(o) {
    _snapshotRootOwner = null;
    releaseSnapshotScope(o);
  },
  clear() {
    clearSnapshots();
    setSnapshotCapture(false);
  }
};

/**
 * Capability installer: snapshot/deferred-source setup. Called by the
 * universal `enableHydration()` and by manifest-composed entries whose client
 * graph has any source that can change during a hydration pass.
 *
 * @internal
 */
export function installSnapshotHydration(): void {
  slots.snap = snapshotHooks;
  markInstalled(CAP_SNAPSHOTS);
}
