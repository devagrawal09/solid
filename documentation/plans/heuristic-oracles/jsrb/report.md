| Test | prod ms | h5 vs prod | r1b vs r0 | r0 vs prod |
| --- | ---: | ---: | ---: | ---: |
| createSignals | 71.7 | −7.7% (noise) | +0.3% (noise) | −8.1% (noise) |
| createComputations | 612.5 | −9.2% (noise) | +0.6% (noise) | +5.0% (noise) |
| updateSignals | 3181.8 | −2.7% (noise) | +3.0% (noise) | +0.1% (noise) |
| avoidablePropagation | 715.1 | −9.8% (noise) | −11.5% (noise) | +1.4% (noise) |
| broadPropagation | 1118.1 | −25.3% | −15.5% | +0.9% (noise) |
| deepPropagation | 401.9 | −28.9% | −25.1% | +0.9% (noise) |
| diamond | 831.9 | −19.8% | −15.3% | +1.8% (noise) |
| mux | 388.4 | −20.5% | −11.7% | −2.5% (noise) |
| repeatedObservers | 121.7 | −6.3% (noise) | −0.2% (noise) | −0.5% (noise) |
| triangle | 263.6 | −20.1% | −14.9% | +0.7% (noise) |
| unstable | 192.3 | −9.4% (noise) | −4.5% (noise) | −0.2% (noise) |
| molBench | 54.5 | −1.8% (noise) | −0.6% (noise) | −0.7% (noise) |
| cellx1000 | 58.7 | −12.3% (noise) | +2.3% (noise) | −4.9% (noise) |
| cellx2500 | 166.4 | −4.5% (noise) | −26.0% (noise) | +38.4% (noise) |
| 2-10x5 - lazy80% | 4056.2 | −20.7% | −14.8% | +2.5% (noise) |
| 6-10x10 - dyn25% - lazy80% | 1003.4 | −12.9% (noise) | −12.3% (noise) | +5.6% (noise) |
| 4-1000x12 - dyn5% | 2055.5 | −8.6% (noise) | +3.9% (noise) | −6.8% (noise) |
| 25-1000x5 | 2357.5 | −1.7% (noise) | +10.4% | −4.7% (noise) |
| 3-5x500 | 709.5 | −16.4% | −11.7% (noise) | +7.2% (noise) |
| 6-100x15 - dyn50% | 988.5 | −12.0% (noise) | −5.2% (noise) | +2.9% (noise) |

Rounds per build: h5 3, prod 3, r0 3, r1b 3.
h5/prod: 7 faster, 0 slower, 13 within noise
r1b/r0: 6 faster, 1 slower, 13 within noise
r0/prod: 0 faster, 0 slower, 20 within noise
