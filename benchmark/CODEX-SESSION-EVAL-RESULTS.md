# Codex Session Eval Results

Generated: 2026-05-04T17:20:00.330Z
Mode: local-service
Status: PASS

## Metrics

- fixtures: 7
- required_fact_recall@context: 1.000
- forbidden_fact_leak_rate: 0.000
- gold_observation_recall@k: 0.714
- context_precision_proxy: 0.714
- session_state_correctness: 1.000
- hook_contract_correctness: 1.000
- hook_p95_ms: 356
- max_context_tokens: 165

## Fixtures

| Fixture | Status | Recall | Leak | Obs Recall | Tokens | Missing | Leaked |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| same-repo-continuation | PASS | 1.000 | 0.000 | 1.000 | 99 | - | - |
| stale-decision-replacement | PASS | 1.000 | 0.000 | 1.000 | 135 | - | - |
| cross-session-implementation-trail | PASS | 1.000 | 0.000 | 1.000 | 165 | - | - |
| stop-then-resume | PASS | 1.000 | 0.000 | 0.000 | 107 | - | - |
| noisy-tool-stream | PASS | 1.000 | 0.000 | 1.000 | 118 | - | - |
| negative-recall | PASS | 1.000 | 0.000 | 1.000 | 73 | - | - |
| budget-pressure | PASS | 1.000 | 0.000 | 0.000 | 146 | - | - |
