---
"@solidjs/blocks": minor
---

`$event(body, { latest: true })` (D-048). By default every call of an event is an independent run, and a run paused on an async `attempt`, `until` or a pending read keeps waiting while later calls start their own. With `latest: true` a new call closes the earlier runs still paused, the way a superseded memo run is closed: the closed run never resumes, its `finally` blocks run, and its call's promise resolves `undefined`. That is "superseded", not a failure, and the event's failure type is unchanged. When typing fast into a search box whose answers arrive out of order, only the last query's results land.
