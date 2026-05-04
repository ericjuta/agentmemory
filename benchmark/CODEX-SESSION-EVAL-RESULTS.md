# Codex Session Eval Results

Generated: 2026-05-04T16:45:21.885Z
Mode: local-service
Status: PASS

## Metrics

- fixtures: 7
- required_fact_recall@context: 1.000
- forbidden_fact_leak_rate: 0.000
- gold_observation_recall@k: 1.000
- context_precision_proxy: 0.512
- session_state_correctness: 1.000
- hook_contract_correctness: 1.000
- hook_p95_ms: 318
- max_context_tokens: 175

## Fixtures

| Fixture | Status | Recall | Leak | Obs Recall | Tokens | Missing | Leaked |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| same-repo-continuation | PASS | 1.000 | 0.000 | 1.000 | 125 | - | - |
| stale-decision-replacement | PASS | 1.000 | 0.000 | 1.000 | 160 | - | - |
| cross-session-implementation-trail | PASS | 1.000 | 0.000 | 1.000 | 175 | - | - |
| stop-then-resume | PASS | 1.000 | 0.000 | 1.000 | 110 | - | - |
| noisy-tool-stream | PASS | 1.000 | 0.000 | 1.000 | 129 | - | - |
| negative-recall | PASS | 1.000 | 0.000 | 1.000 | 98 | - | - |
| budget-pressure | PASS | 1.000 | 0.000 | 1.000 | 139 | - | - |
