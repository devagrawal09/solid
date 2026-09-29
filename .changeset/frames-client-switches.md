---
"@solidjs/web": patch
---

The frames client (`@solidjs/web/frames`, browser) gains link-time feature switches: `FRAGMENTS`, `ASSETS`, `SLOT_DATA`, `ASYNC_ARGS`, `CONTAINERS`, `LIVE_PROPS`, `SINGLE_FLIGHT`, `FULL_CODEC` and `HYDRATION_CLAIMS`. They are imported from `frames/dist/client.features.js`, and every switch is on in the published build, so behavior is unchanged. The capability linker can switch features off for an app whose compiled server output never produces them (up to 11.1 KB gz of the 30.9 KB gz client when every switch is off). A feature reached with its switch off throws `[FEATURE_EXCLUDED]`.
