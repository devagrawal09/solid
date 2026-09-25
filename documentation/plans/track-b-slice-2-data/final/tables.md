| Workload | handwritten (base) | previous lowering (base) | handwritten (stage 1) | stage 1 reader | stage 1 reader, fused | handwritten (stage 2) | stage 1 reader (stage 2 build) | handle root | no-escape store |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shallow (ns/read) | 105 (1.00x) | 534 (5.07x) | 104 (0.99x) | 117 (1.11x) | 113 (1.07x) | 105 (1.00x) | 120 (1.14x) | 68 (0.64x) | 69 (0.66x) |
| deep (ns/read) | 407 (1.00x) | 924 (2.27x) | 408 (1.00x) | 308 (0.76x) | 309 (0.76x) | 421 (1.03x) | 327 (0.80x) | 280 (0.69x) | 278 (0.68x) |
| dynamic (ns/read) | 562 (1.00x) | 1159 (2.06x) | 615 (1.09x) | 370 (0.66x) | 398 (0.71x) | 615 (1.10x) | 394 (0.70x) | 349 (0.62x) | 364 (0.65x) |
| list (ns/read) | 3100 (1.00x) | 5132 (1.66x) | 2884 (0.93x) | 2728 (0.88x) | 2544 (0.82x) | 2937 (0.95x) | 2703 (0.87x) | 2582 (0.83x) | — |
| mount (ns/row) | 7869 (1.00x) | 10243 (1.30x) | 7946 (1.01x) | 7194 (0.91x) | — | 8090 (1.03x) | 7256 (0.92x) | 6523 (0.83x) | 6530 (0.83x) |
| update (ns/op) | 6628 (1.00x) | 6460 (0.97x) | 5629 (0.85x) | 6017 (0.91x) | — | 5299 (0.80x) | 5022 (0.76x) | 5132 (0.77x) | 5294 (0.80x) |

Run-to-run spread (max−min of the three run medians, relative): median 6.4%, max 70.4%.

| Stage 1 build | fixed arity (fused) | `readPathN`, hoisted keys | `readPathN`, inline array |
| --- | --- | --- | --- |
| shallow | 113 | 119 | 117 |
| deep | 309 | 315 | 307 |
| dynamic | 398 | — | 405 |

| Workload (B per read/row/op) | handwritten (base) | previous lowering (base) | handwritten (stage 1) | stage 1 reader | stage 1 reader, fused | handwritten (stage 2) | stage 1 reader (stage 2 build) | handle root | no-escape store |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shallow | 0.7 | 665.6 | 0.7 | 1.0 | 0.6 | 0.7 | 1.0 | 0.3 | 0.3 |
| deep | 0.6 | 665.4 | 0.3 | 0.6 | 0.3 | 0.3 | 0.6 | 0.3 | 0.3 |
| dynamic | 1.8 | 706.5 | 1.5 | 1.8 | 1.5 | 1.5 | 1.8 | 1.5 | 1.5 |
| list | 619.7 | 2062.2 | 619.7 | 732.7 | 619.7 | 619.7 | 732.7 | 619.7 | — |
| mount | 2600.7 | 4427.7 | 2594.7 | 2595.2 | — | 2594.5 | 2593.8 | 2530.9 | 2530.1 |
| update | 2877.2 | 3308.0 | 2670.4 | 2293.2 | — | 2670.4 | 2293.2 | 2150.4 | 2150.4 |

