#!/usr/bin/env bash
# One independent JFB CPU run over every Solid 2 variant (build.mjs), with
# JFB's own runner (webdriver-ts, --runner playwright, default 15 iterations; 04_select1k
# adds JFB's 10 extra runs). JFB loops benchmark-outer / framework-inner, so the
# variants are interleaved per benchmark. Pass "reverse" to flip the framework
# order (run 2) so a slow drift cannot favour one variant.
#
#   JFB=<checkout> scripts/heuristics/jfb/run.sh <out-dir> [reverse]
#
# Runner: JFB's playwright runner (JFB's default is puppeteer; with puppeteer
# 25.3 + this Chromium 141 most traces also captured the warmup clicks and JFB
# rejected them, "at most one mousedown event is expected"). Playwright launches
# without the sandbox itself, so no JFB patch is needed. Chromium is the
# pre-installed Playwright build, passed with --chromeBinary.
set -euo pipefail
OUT=$(realpath -m "$1")
ORDER=${2:-forward}
: "${JFB:?set JFB to the js-framework-benchmark checkout}"
CHROME=${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}
FW=(solid-next solid-next-h7 solid-next-l1 solid-next-h7l1 solid-next-child solid-next-child-h7 solid-next-rspec-r0 solid-next-rspec-r1b)
if [ "$ORDER" = reverse ]; then
  for ((i = ${#FW[@]} - 1; i >= 0; i--)); do R+=("${FW[i]}"); done
  FW=("${R[@]}")
fi
ARGS=()
for f in "${FW[@]}"; do ARGS+=("keyed/$f"); done
mkdir -p "$OUT"
cd "$JFB/webdriver-ts"
rm -rf results
date -u +%FT%TZ >"$OUT/started"
LANG=en_US.UTF-8 ${PIN:-} node dist/benchmarkRunner.js --headless --runner playwright \
  --chromeBinary "$CHROME" \
  --framework "${ARGS[@]}" \
  --benchmark 01_run1k 02_replace1k 03_update10th1k_x16 04_select1k 05_swap1k 06_remove-one-1k 07_create10k 08_create1k-after1k_x2 09_clear1k_x8 \
  >"$OUT/runner.log" 2>&1 || true
# JFB drops a whole (framework, benchmark) pair when one trace fails its
# parser invariants (sporadic "at most one mousedown event is expected").
# Re-run only the missing pairs, up to 3 times each; recorded in retries.log.
BENCHES=(01_run1k 02_replace1k 03_update10th1k_x16 04_select1k 05_swap1k 06_remove-one-1k 07_create10k 08_create1k-after1k_x2 09_clear1k_x8)
for attempt in 1 2 3; do
  missing=0
  for f in "${FW[@]}"; do
    for b in "${BENCHES[@]}"; do
      ls results/${f}-v2.0.0-rc.8-local-keyed_${b}.json >/dev/null 2>&1 && continue
      missing=1
      echo "attempt $attempt: $f $b" >>"$OUT/retries.log"
      LANG=en_US.UTF-8 ${PIN:-} node dist/benchmarkRunner.js --headless --runner playwright \
        --chromeBinary "$CHROME" --framework "keyed/$f" --benchmark "$b" >>"$OUT/runner-retry.log" 2>&1 || true
    done
  done
  [ $missing = 0 ] && break
done
date -u +%FT%TZ >"$OUT/finished"
cp results/*.json "$OUT/"
