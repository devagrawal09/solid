// @solidjs/web/hydration-manifest — the CONSUMER side of the client hydration
// capability manifest (optimization slice 7): schema, validation, and the
// entry composer. Build-time only (no DOM, no runtime imports). Manifest
// PRODUCTION is deliberately not here: producers implement
// `HydrationManifestProducer` elsewhere (deterministic fixtures now, the
// Track C linker later) and this module never imports one.
export {
  HYDRATION_MANIFEST_SCHEMA,
  HYDRATION_CAPABILITY_KEYS,
  type ClientHydrationManifest,
  type HydrationCapabilities,
  type HydrationCapabilityKey,
  type HydrationManifestProducer,
  type SsrSourcePolicyName
} from "./schema.js";
export {
  validateHydrationManifest,
  assertHydrationManifest,
  type ManifestValidation
} from "./validate.js";
export {
  composeHydrationEntry,
  composeServerHydrationOptions,
  resolveHydrationInstallers,
  serializeHydrationManifest,
  type CapabilityInstaller,
  type CapabilityConsumers,
  type ComposeOptions
} from "./compose.js";
