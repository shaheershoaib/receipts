# Applying the Gates across software types

The Gates are stated as principles, not procedures. "Assert the rendered value" and
"land on the surface the reporter sees" do not say *use a browser* - they cannot, because
what counts as a "surface" or a "value" depends on what you are building. This file maps
each medium-varying gate to the concrete artifact and tool for the common software types,
and gives a template for any type not listed.

The agent picks the right column from `receipts.config.json` `gates.medium` (a hint, not a
hard switch) plus the project's stack and config; an unknown medium falls back to the
principle. The point is universality: the same fourteen gates, applied in the terms of
whatever you ship.

## The observation contract (what every medium must answer)

A "medium" is just a set of answers to these questions. To apply the Gates anywhere,
answer them for your project:

1. **Surface** - where does the behavior manifest to whoever consumes it? (G2/G4)
2. **Value** - what is the concrete observable you assert, never mere presence? (G1)
3. **Observe-by** - what tool reads that value? (G1)
4. **Terminal action** - what operation commits the effect, at the end of the flow? (G5)
5. **Build / artifact** - what does "the build that carries your commit" mean? (G3)
6. **Twin** - where is the same pattern re-implemented? (G6)
7. **Dependent** - what consumes what you changed? (G7)
8. **Receipt** - what automated test re-proves it, red-before / green-after? (G0)
9. **Compatibility boundary** - where do producer and consumer update independently? (G10)

## The medium-varying gates, restated as invariants

- **G1 assert the value** - read the real observable output, never presence or a
  placeholder. The *observable* varies; "read the actual value" does not.
- **G3 right build** - verify against the artifact that carries your commit. The *artifact*
  varies (a deploy sha, a package version, an image tag, an applied state).
- **G4 right surface** - the change must land where the consumer perceives it. The
  *surface* varies (a page, an endpoint, a function, a command, a table).
- **G5 terminal action** - drive to the operation that commits, through the state seams.
  The *action* varies (a UI submit, a write request, a mutating call, a command).
- **G10 compatibility across the independent-update boundary** - the two sides that update
  separately must stay compatible across the window. The *boundary* varies: deploy-order
  for services, semver for libraries, migration-order for databases, schema-evolution for
  data pipelines, API-versioning for contracts.

The rest (G0 reproduce-first, G2 pin the flow, G6 sweep twins, G7 verify dependents, G8
fresh base, G9 trustworthy green) are already medium-agnostic in wording; only their nouns
("surface", "value") resolve through the rows below.

## The map

| Medium | Surface (G4) | Value + observe-by (G1) | Terminal action (G5) | Build / artifact (G3) | Receipt (G0) |
|---|---|---|---|---|---|
| Web frontend | the page/route the user opens | DOM text / `input.value` / aria state, via a browser (Playwright, headless, preview) | submit/save in the UI | the deployed bundle (deploy sha) | component/e2e test (jest+RTL, Playwright, Cypress) |
| API / service (REST/GraphQL/gRPC) | the endpoint + its response contract | response status/body/field, via an HTTP/gRPC client | the write request that persists (POST/PUT/mutation) | the deployed service (sha via `/health` or the deployments API) | a request/integration test |
| Library / package / SDK | the public API (exported fns/types) | return value / thrown error / mutated state, by calling it | the call that performs the operation | the built/published package (version + artifact) | a unit test against the public API |
| CLI tool | the command + stdout/stderr/exit/files | stdout, exit code, files written, by running it | the subcommand that performs the effect | the built binary (`--version`) | run-and-assert (invoke, check output/exit) |
| Mobile app (iOS/Android) | the screen | the on-screen element's value, via XCUITest / Espresso / a simulator | the tap that commits | the installed build (build number) | a UI / instrumentation test |
| Desktop GUI (Electron/native) | the window/view | the control's state, via UI automation | the action control | the packaged app version | a UI test |
| Data / ETL pipeline | the output dataset/table/metric | row counts, column values, aggregates, schema, by querying the output | the job run that writes the output | the deployed DAG / job version | a data test (dbt test, Great Expectations, an assertion query) |
| ML model / pipeline | the prediction/metric on a pinned eval | a metric (accuracy/F1/loss) on a fixed eval set, or a specific prediction | the eval / scoring step | the model artifact version + serving deploy | an eval test on a pinned dataset (regression = red) |
| Infra as Code (Terraform/k8s/Helm) | the provisioned resource's actual state | the resource attribute (a rule, a replica count), via a plan diff / cloud read-back | `apply` (convergence) | the applied state (state version / manifest) | a plan/policy test (terraform plan assert, conftest/OPA) |
| Database / migration | the schema + data after migrating | column type/existence, row values incl. legacy rows, by querying | the migration `apply` (and rollback) | the migrated DB at the deployed sha | a migration test on a fixture incl. legacy data |
| Smart contract | on-chain state after a tx | balances / storage, via view calls | the state-changing tx | the deployed contract (address/bytecode) | a contract test (Foundry/Hardhat), red->green |
| Browser extension | the injected UI / the modified page | the injected DOM/behavior, via a browser with the extension loaded | the action it triggers | the packaged extension version | an e2e with the extension loaded |
| Embedded / firmware | device behavior (a pin/signal/serial line) | the signal / register / output, via hardware-in-the-loop or an emulator | the command that actuates | the flashed image version | an on-target / emulator test |
| Game | the game state / rendered frame | entity state / score / physics, via a state-reading harness or a deterministic sim | the action that commits | the built version | a sim / state test |

## Per-gate notes that bite

- **G10's boundary is different per medium.** Services: deploy order (the new producer must
  not break the still-old consumer during the window). Libraries: semver (a breaking change
  is a major bump; a consumer pinned to the old major must not break). Databases:
  migration order + expand/contract (add the column before the code reads it; drop only
  after the code stops). Data pipelines: schema evolution (downstream tables/dashboards
  survive the column change). APIs: versioned endpoints or additive-only changes. One
  principle, the medium's mechanism.
- **G3 for a no-deploy medium** (a library / CLI) is satisfied by construction - the test
  runs the code at your commit - so its sha-binding degrades to the package version / built
  artifact. `receipts init` sets `build.sha_source: "none"` for these, and the deployed-build
  Stop hook stands down (the receipt re-run at the PR is the proof).
- **G4 / G5 can collapse for a pure library** - the "surface" is the function and the "flow"
  is the call, both covered by G1/G2; for a library you may disable G4/G5 in
  `gates.disabled` rather than reinterpret them. A CLI keeps both (its output is a surface,
  its subcommand a terminal action).
- **The "representative environment" (G1, G9) varies**: a real DB engine (not SQLite) for a
  service, a real browser (not jsdom) for a web app, the target architecture for embedded,
  the pinned eval set for ML.

## Extending to a new medium

If your software type is not in the table, do not invent a procedure - answer the
observation contract above for it, then apply each gate's invariant. Pick the closest
archetype to start from: most request/response systems behave like the API row, most
user-facing surfaces like the web/mobile rows, most artifacts-without-a-deploy like the
library row. Record your answers next to your `receipts.config.json` so the next person
inherits them, and if it is a type others will hit, add a row here. The contract is the
universal part; the rows are just worked examples of it.

## How the config drives this

- `gates.medium` selects the row (a hint; the agent confirms it against the real stack).
- `gates.enabled` / `gates.disabled` turn off the gates that genuinely do not apply (e.g.
  G4/G5 for a pure library, G10 for a single unit with no independent consumer).
- The functional plumbing (`verify.test_command`, `build.sha_source`,
  `build.deploy_host_patterns`) encodes the medium concretely, so the agent and the
  enforcer both act in the right terms.
