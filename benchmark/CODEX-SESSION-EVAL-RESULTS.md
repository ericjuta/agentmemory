# Codex Session Eval Results

Generated: 2026-05-05T17:25:54.534Z
Mode: local-service
Status: PASS

## Metrics

- fixtures: 20
- required_fact_recall@context: 1.000
- forbidden_fact_leak_rate: 0.000
- gold_observation_recall@k: 0.900
- context_precision_proxy: 0.785
- session_state_correctness: 1.000
- hook_contract_correctness: 1.000
- hook_p95_ms: 338
- max_context_tokens: 232

## Warnings

- stop-then-resume: fact_recall_from_context is 1.000 but source_recall is 0.000 below 0.85
- budget-pressure: fact_recall_from_context is 1.000 but source_recall is 0.000 below 0.85

## Fixtures

| Fixture | Status | Recall | Leak | Obs Recall | Tokens | Missing | Leaked |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| same-repo-continuation | PASS | 1.000 | 0.000 | 1.000 | 99 | - | - |
| stale-decision-replacement | PASS | 1.000 | 0.000 | 1.000 | 135 | - | - |
| cross-session-implementation-trail | PASS | 1.000 | 0.000 | 1.000 | 165 | - | - |
| stop-then-resume | PASS | 1.000 | 0.000 | 0.000 | 107 | - | - |
| noisy-tool-stream | PASS | 1.000 | 0.000 | 1.000 | 118 | - | - |
| negative-recall | PASS | 1.000 | 0.000 | 1.000 | 73 | - | - |
| budget-pressure | PASS | 1.000 | 0.000 | 0.000 | 154 | - | - |
| multi-repo-project-identity | PASS | 1.000 | 0.000 | 1.000 | 81 | - | - |
| long-session-selective-survival | PASS | 1.000 | 0.000 | 1.000 | 232 | - | - |
| fresh-session-handoff | PASS | 1.000 | 0.000 | 1.000 | 81 | - | - |
| branch-worktree-isolation | PASS | 1.000 | 0.000 | 1.000 | 77 | - | - |
| prompt-only-user-decision | PASS | 1.000 | 0.000 | 1.000 | 66 | - | - |
| failed-tool-correction | PASS | 1.000 | 0.000 | 1.000 | 109 | - | - |
| secret-redaction-boundary | PASS | 1.000 | 0.000 | 1.000 | 85 | - | - |
| subagent-ownership | PASS | 1.000 | 0.000 | 1.000 | 83 | - | - |
| runtime-vs-repo-boundary | PASS | 1.000 | 0.000 | 1.000 | 81 | - | - |
| user-correction-over-agent-assumption | PASS | 1.000 | 0.000 | 1.000 | 100 | - | - |
| test-diagnosis-regression | PASS | 1.000 | 0.000 | 1.000 | 119 | - | - |
| generated-artifact-handoff | PASS | 1.000 | 0.000 | 1.000 | 76 | - | - |
| no-op-no-reply-contract | PASS | 1.000 | 0.000 | 1.000 | 73 | - | - |
