# WP 2.2 — Navgraph pair-generation batch summary

Run label: `primary`  |  count/map target: 60  |  seed: 1

Maps tested: **12**

## Per-map results

| mask | Mpx | nodes | edges | n | valid-rate | mean retries | median retries | p90 retries | mean ms/valid | gate | top rejection reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---|
| mask_20250602_081036 | 1.73 | 1058 | 3160 | 60 | 37% | 1.7 | 1 | 5 | 16.8 | PASS | side:56, routeside:16, obstacle:15 |
| mask_20250604_084444 | 8.27 | 2992 | 7802 | 60 | 56% | 0.78 | 0 | 3 | 14.1 | PASS | side:17, balanced:17, routeside:13 |
| mask_20250604_133535 | 1.97 | 1051 | 3028 | 60 | 51% | 0.97 | 0 | 3 | 13.5 | PASS | side:27, balanced:16, obstacle:8 |
| mask_20250605_092134 | 6.74 | 3479 | 8695 | 60 | 39% | 1.53 | 1 | 5 | 22.7 | PASS | side:51, routeside:17, obstacle:13 |
| mask_20250605_123114 | 4.05 | 2974 | 8469 | 60 | 63% | 0.6 | 0 | 2 | 18.4 | PASS | side:13, routeside:10, balanced:10 |
| mask_20250605_125618 | 2.93 | 2166 | 5935 | 60 | 38% | 1.62 | 1 | 4 | 21.2 | PASS | side:53, obstacle:21, balanced:14 |
| mask_20250614_081424 | 4.42 | 2452 | 6153 | 60 | 44% | 1.25 | 1 | 3 | 12.9 | PASS | side:35, balanced:23, routeside:9 |
| mask_20250622_205149 | 3.8 | 1393 | 3235 | 60 | 65% | 0.55 | 0 | 2 | 3.8 | PASS | side:14, balanced:11, routeside:4 |
| mask_20250623_153955 | 4 | 1533 | 4148 | 60 | 51% | 0.95 | 1 | 2 | 8.9 | PASS | side:28, balanced:17, routeside:12 |
| mask_20250628_083449 | 2.39 | 1726 | 4720 | 60 | 48% | 1.1 | 1 | 3 | 15.2 | PASS | balanced:28, side:25, routeside:12 |
| mask_20250714_184638 | 1.26 | 1203 | 3006 | 60 | 41% | 1.47 | 1 | 4 | 8.5 | PASS | side:32, balanced:25, routeside:19 |
| mask_20250826_121149 | 4.01 | 1949 | 4330 | 60 | 59% | 0.68 | 0 | 2 | 15.6 | PASS | balanced:17, side:14, routeside:10 |

## Aggregate

- Total attempts: 1512, total valid pairs: 720
- Aggregate valid-rate: **47.6%**
- Mean of per-map mean-retries: **1.10**
- Mean of per-map mean-ms/valid: **14.3 ms**
- Maps meeting gate (mean retries <= 5 AND mean ms/valid <= 1000): **12/12 (100.0%)**
- Aggregate rejection reasons: {"empty":0,"distance":1,"obstacle":84,"snap":0,"unreachable":0,"distinct":0,"runtime":0,"side":365,"routeside":138,"lateral":0,"timeout":0,"runtime_refined":1,"balanced":203}

## Served relative-gap distribution

- Mean of per-map mean relative gap: **0.1362**  |  mean of per-map median: **0.1129**
- Aggregate gap histogram (served pairs): {"<0.05":31,"<0.10":274,"<0.15":183,"<0.20":93,"<0.30":93,"<0.40":46,">=0.40":0}

## Legality assertion (mandatory)

Total legality violations across all accepted pairs, both routes, on ALL maps: **0**

Zero violations confirmed — every accepted pair, both routes, refined to a legal full-res polyline.

## GO / NO-GO verdict

**GO**

Acceptance criteria (plan.md WP 2.2):
- mean retries <= ~5 AND mean time-to-valid-pair <= ~1s on >=70% of urban maps: 100.0% of maps passed -> MET
- zero legality violations: MET (0 found)

## Rejection-reason commentary & tuning notes

`side` rejections dominate (365 of 1512 attempts, 24.1%), consistent with the city-gen reference run where `side` was also the top rejection reason. This is the selectRuntimeRouteOptions() opposite-side + sideGap>=sideGapMinPx filter (DEFAULT_CONFIG.sideGapMinPx=40) rejecting route pairs that go the same way around obstacles.

Suggested tuning directions for a later WP (NOT applied here — this run uses DEFAULT_CONFIG unless a --side-gap override is noted above):
- Lower `sideGapMinPx` (currently 40px) to accept more near-parallel route pairs — trades visual distinctness for retry rate.
- Widen `distMinPx`/`distMaxPx` (currently 500/1500px) so more sampled pairs naturally have route options that diverge around different obstacles.
- Increase `obstacleMinRunPx` (currently 8px) so only pairs with a meaningfully large obstacle between them are accepted at prefilter time, which correlates with wider route divergence downstream.
- Increase `routeAttempts` (currently 4) so more barrier-forced alternates are tried before giving up on a pair.
