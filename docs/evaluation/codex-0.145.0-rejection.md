# Codex 0.145.0 compatibility rejection

## Status

Option B is selected for issue #99 contract v3. The exact official npm candidate
`@openai/codex@0.145.0` is rejected on the `no-effect-authority` absolute gate. Epic #98 must return
to planning without a runtime ADR or fallback candidate.

The rejection is bound to readiness fingerprint
`00a484d5cd28890bc95eab9c3d8867aad893e254337e8d0881826dac82c1c2ff`. The closed machine record is
[`codex-0.145.0-rejection.json`](codex-0.145.0-rejection.json), SHA-256
`c1663d16c17d20b8af4cc128042cbbc10dbb6cea9e619170719bc016426b1a07`.

Evaluation occurred on the ADR-0006 physical authority: Apple M4 with 16 GiB, macOS 26.5.1, arm64.
The repository quality control used Node.js 24.18.0 and npm 11.16.0.

## Decision

The candidate cannot prove that the frozen no-effect turn executes no local action. Its turn
environment field is experimental, and an empty environment omits environment tools. However,
`update_plan` is registered independently and unconditionally. Its local handler applies a plan
update without a pre-execution approval or denial exchange. The client also fixes tool choice to
`auto`; the turn request has no deny-all tool-choice field.

The frozen prompt expressly says not to perform any local action. Whether a model happens not to
select `update_plan` is not an authority control, and post-selection observation is not
pre-execution denial. The issue requires a proven no-effect/tool-denial posture and mandates
rejection when the candidate can execute before denial. The deterministic reason code is
`local-tool-cannot-be-preexecution-denied`.

This is a capability-boundary rejection, not evidence that `update_plan` performs a shell,
filesystem, or repository mutation. A later version could be reconsidered only through a new owner
decision with a new exact candidate.

## Reproducible source chain

All source links are pinned to upstream commit
[`25af12f7e61572b0bc18ddb1008be543b91519b0`](https://github.com/openai/codex/commit/25af12f7e61572b0bc18ddb1008be543b91519b0),
resolved from annotated tag
[`rust-v0.145.0`](https://github.com/openai/codex/releases/tag/rust-v0.145.0).

| Source                                                                                                                                                                  | Finding                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Turn environment contract](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L90-L97) | The field is experimental and exposes no deny-all tool-choice control.      |
| [Tool-spec construction](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/tools/spec_plan.rs#L622-L760)                  | Empty environments omit environment tools but still register the plan tool. |
| [Plan handler](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/tools/handlers/plan.rs#L48-L95)                          | The local update executes without a pre-execution approval exchange.        |
| [Client request](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/client.rs#L891-L897)                                   | Tool choice is fixed to `auto`.                                             |
| [Empty-environment test](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/tools/spec_plan_tests.rs#L622-L644)            | It corroborates environment-tool omission, not a closed no-tool posture.    |

## Artifact, schema, provenance, and licence bindings

The official npm wrapper has integrity
`sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ==`
and tarball SHA-256
`416399796cac371d1a033b17f34b08ba9b25c8f298a5b9d00e10f72c3b128c8d`. The resolved
`0.145.0-darwin-arm64` package has integrity
`sha512-h6aQ0UxnaP8mIM/9/qPAH9MNkRliJo88toq1T36IxNM2L5JSU0TFamu+MZn7YkFgDsrp0RfiI+97Tm8AVVxqtA==`,
tarball SHA-256 `53ff1055d35ca3dc964e8bedc2431e46c00608f7c8e145b222122648a7a4e3e8`,
and binary SHA-256 `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590`.

Both exact npm records declare Apache-2.0 and supplied verified npm signatures and SLSA provenance
attestations. The binary signature resolved to OpenAI OpCo, LLC, team `2DC432GLL2`.

| Provenance source                                                                                                                    | Binding                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [Release workflow](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/.github/workflows/rust-release.yml) | Official source build and publication route |

The exact package was evaluation-only, is not a productive dependency, and creates no shipped
notice or package-policy change.

Generated schema inventories were inspected and then deleted. Their closed bindings are:

| Schema projection       | Files | SHA-256                                                            |
| ----------------------- | ----: | ------------------------------------------------------------------ |
| Stable JSON             |   273 | `ea5365fef3204e9bac265262d616e3c1a4896ee27ed9ae38d8b392a574c858a5` |
| Experimental JSON       |   347 | `27a7e1d4002cb2987bd00b7186c85cda9ffcbaac036afab6d191f5c98a4ac2da` |
| Stable TypeScript       |   617 | `bfe516c4dab610ddecc10ae40763cec197d8673853705f2cf39bb07f74bdd0ca` |
| Experimental TypeScript |   697 | `9f2716686ccc10c0fedcea92363f8ac0ad8eafcc081855e284a28c358c6ec82d` |

## Evaluation disposition

| Gate                         | Result      | Evidence or disposition                                                          |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------- |
| Artifact and provenance      | Bound       | Exact package, platform package, binary, source, signature, and licence recorded |
| Protocol compatibility       | Rejected    | Required no-effect authority cannot be expressed or enforced before execution    |
| Authentication and isolation | Not started | Mandatory stop occurred before credential or provider access                     |
| No-effect authority          | Failed      | Unconditional local plan tool has no pre-execution denial                        |
| Bounds and performance       | Not started | Full matrix is prohibited after an absolute-gate failure                         |
| Cancellation and cleanup     | Not started | Full matrix is prohibited after an absolute-gate failure                         |
| Evidence hygiene             | Passed      | Only closed metadata and immutable source bindings are retained                  |

No authenticated generic turn, cancellation repetition, or provider request was executed. The
frozen prompt fixture is intentionally retained as accepted contract input. No provider-submitted
task or provider response content, credential value, dedicated authentication state, raw protocol,
selected-repository context, machine path, generated full schema, temporary source, package, or
runtime binary is retained. Not running the remaining matrix is the required fail-closed behavior,
not missing qualification evidence.

## Frozen prompt and reproduction

The repository fixture is exactly 182 bytes with SHA-256
`e1a92579b1ca673135331829beb97792c1289a6bccdfe0303302256c546960f6`. Reproduce the decision with:

```text
npm run evaluate:codex-compatibility:macos -- --candidate @openai/codex@0.145.0
```

The command accepts no alternate candidate, additional argument, credential, path, prompt,
endpoint, or fallback. For the exact candidate it emits only the closed rejection schema and exits
with status 1. Invalid input or a changed evidence/prompt binding exits with status 2.

## Acceptance and residual uncertainty

AC1 and AC2 cannot pass because the absolute gate failed before the repetition matrix. AC3 is
satisfied by the attributable rejection evidence and no-fallback decision. AC4 is satisfied:
evaluation artifacts and sensitive or content-bearing data are absent.

The retained evidence does not claim that every future Codex release lacks a governable no-effect
mode. It establishes only that the exact `@openai/codex@0.145.0` macOS arm64 compatibility unit
cannot meet issue #99's frozen authority contract.
