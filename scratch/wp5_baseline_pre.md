# WP 2.2 — Navgraph pair-generation batch summary

Run label: `primary`  |  count/map target: 60  |  seed: 1

Maps tested: **12**

## Per-map results

| mask | Mpx | nodes | edges | n | valid-rate | mean retries | median retries | p90 retries | mean ms/valid | gate | top rejection reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---|
| mask_20250602_081036 | 1.73 | 1058 | 3160 | 60 | 31% | 2.25 | 1 | 6 | 1.8 | PASS | side:68, routeside:46, obstacle:18 |
| mask_20250604_084444 | 8.27 | 2992 | 7802 | 60 | 40% | 1.52 | 1 | 5 | 1.9 | PASS | side:42, routeside:41, obstacle:7 |
| mask_20250604_133535 | 1.97 | 1051 | 3028 | 60 | 43% | 1.3 | 0.5 | 4 | 2 | PASS | routeside:44, side:31, obstacle:3 |
| mask_20250605_092134 | 6.74 | 3479 | 8695 | 60 | 24% | 3.17 | 2 | 8 | 2.7 | PASS | side:107, routeside:60, obstacle:21 |
| mask_20250605_123114 | 4.05 | 2974 | 8469 | 60 | 43% | 1.35 | 1 | 5 | 2.5 | PASS | side:41, routeside:33, obstacle:6 |
| mask_20250605_125618 | 2.93 | 2166 | 5935 | 60 | 32% | 2.12 | 1 | 7 | 2.6 | PASS | side:67, routeside:39, obstacle:17 |
| mask_20250614_081424 | 4.42 | 2452 | 6153 | 60 | 50% | 1.02 | 0.5 | 3 | 2 | PASS | side:33, routeside:24, obstacle:3 |
| mask_20250622_205149 | 3.8 | 1393 | 3235 | 60 | 46% | 1.18 | 1 | 3 | 1.3 | PASS | routeside:34, side:31, obstacle:5 |
| mask_20250623_153955 | 4 | 1533 | 4148 | 60 | 43% | 1.33 | 0 | 4 | 1.4 | PASS | side:43, routeside:37 |
| mask_20250628_083449 | 2.39 | 1726 | 4720 | 60 | 40% | 1.48 | 1 | 4 | 2.1 | PASS | routeside:53, side:35, obstacle:1 |
| mask_20250714_184638 | 1.26 | 1203 | 3006 | 60 | 36% | 1.82 | 1 | 5 | 1.3 | PASS | side:62, routeside:34, obstacle:13 |
| mask_20250826_121149 | 4.01 | 1949 | 4330 | 60 | 56% | 0.8 | 0 | 3 | 2 | PASS | routeside:34, side:11, runtime:2 |

## Aggregate

- Total attempts: 1880, total valid pairs: 720
- Aggregate valid-rate: **38.3%**
- Mean of per-map mean-retries: **1.61**
- Mean of per-map mean-ms/valid: **2.0 ms**
- Maps meeting gate (mean retries <= 5 AND mean ms/valid <= 1000): **12/12 (100.0%)**
- Aggregate rejection reasons: {"routeside":479,"side":571,"ok":720,"obstacle":94,"runtime":10,"distinct":3,"snap":3}

## Legality assertion (mandatory)

Total legality violations across all accepted pairs, both routes, on ALL maps: **0**

Zero violations confirmed — every accepted pair, both routes, refined to a legal full-res polyline.

## GO / NO-GO verdict

**GO**

Acceptance criteria (plan.md WP 2.2):
- mean retries <= ~5 AND mean time-to-valid-pair <= ~1s on >=70% of urban maps: 100.0% of maps passed -> MET
- zero legality violations: MET (0 found)

## Rejection-reason commentary & tuning notes

`side` rejections dominate (571 of 1880 attempts, 30.4%), consistent with the city-gen reference run where `side` was also the top rejection reason. This is the selectRuntimeRouteOptions() opposite-side + sideGap>=sideGapMinPx filter (DEFAULT_CONFIG.sideGapMinPx=40) rejecting route pairs that go the same way around obstacles.

Suggested tuning directions for a later WP (NOT applied here — this run uses DEFAULT_CONFIG unless a --side-gap override is noted above):
- Lower `sideGapMinPx` (currently 40px) to accept more near-parallel route pairs — trades visual distinctness for retry rate.
- Widen `distMinPx`/`distMaxPx` (currently 500/1500px) so more sampled pairs naturally have route options that diverge around different obstacles.
- Increase `obstacleMinRunPx` (currently 8px) so only pairs with a meaningfully large obstacle between them are accepted at prefilter time, which correlates with wider route divergence downstream.
- Increase `routeAttempts` (currently 4) so more barrier-forced alternates are tried before giving up on a pair.
