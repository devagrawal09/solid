#!/bin/sh
# Two independent runs of both suites, pinned to CPUs 0,1.
set -e
cd "$(dirname "$0")/../../.."
OUT=documentation/plans/heuristic-oracles/stack-a
for run in 1 2; do
  for suite in list rows; do
    taskset -c 0,1 node scripts/heuristics/stack-a/bench.mjs --suite $suite --n 1000 --reps 5 --out $OUT/$suite-$run.json
  done
done
