# HERMES Intelligence Engine

## Role

Correlate scanner output, baselines, and inventory into **explainable** risk assessments.

## Output shape (always)

```text
Risk
Confidence
Evidence[]   (check + value)
Sources[]    (port, banner, version, CVE/NVD, agent inventory)
Timestamp
Recommendation
```

## Rules of honesty

- Never invent vulnerabilities.
- Uncertain version matches → `is_potential = true` / `POTENTIAL VULNERABILITY`.
- Risk score is a model output, not an absolute fact — show `reasons[]` and `factors`.

## Risk factors

- CVSS / severity of open findings  
- Open port count and risky services  
- Internet exposure flag  
- Patch/inventory status (when available)  
- Network position / authorized asset criticality  

## Posture score

`hermes_assets.posture_score` and latest `hermes_risk_scores` row:

```text
100 − 25×critical − 15×high − 8×medium − 3×low − port penalty
```

Displayed with **Why is this score?** reasons.

## Future LLM integration

The engine is deterministic today (rules + evidence). An optional LLM may only *summarize* stored evidence — it must not add findings.
