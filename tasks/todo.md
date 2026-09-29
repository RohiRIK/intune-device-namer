# Implementation plan

- [x] Confirm output location, platforms, naming flexibility, Entra drift behavior, and authentication.
- [x] Implement strict-TS Bun CLI with templates, device inventory, platform guards, and JSON preview.
- [x] Add delegated device-code and app-only client-credential Graph authentication, pagination and retry.
- [x] Implement saved-plan verification and explicit guarded beta remote rename, with per-device reporting.
- [x] Provide macOS root shell script generator and setup/impact documentation.
- [x] Verify build, types, tests, CLI output and review files.

## Design constraints

Intune's Device name, Intune's Management name, Entra displayName, and local hostname are different. Entra is report-only. Graph setDeviceName is beta; use only with explicit opt-in. Corporate-owned Windows/macOS and supported corporate Android Enterprise modes and supervised iOS/iPadOS are eligible. Windows hybrid join and personal ownership are ineligible. iOS ADE templates can overwrite a remote rename; skip devices with an enrollment profile by default, unless an explicit override is given. No tenant policies or assignments will be provisioned automatically. Each apply re-reads the device before posting, and never renames if the saved snapshot is stale.

## Review

`bun run build`, `bun run typecheck` and `bun test` passed (6 tests). Offline CLI help, template JSON piped to `jq`, validation, and generated macOS script `/bin/sh -n` passed. No live Graph calls were made because no tenant credentials/test devices were provided. The workspace is not a git repository, so git diff was unavailable; source/docs were reviewed directly. No linter is configured.

## Follow-up: interactive wizard

- [x] Add guided, TTY-only wizard that previews by default, optionally saves a plan, and gates apply behind explicit beta opt-in and typed confirmation.
- [x] Add a PowerShell launcher for Windows administrators; keep Bun as the CLI runtime.
- [x] Document workflow and verify preview/cancel/apply gates with tests and build/type checks.

Wizard review: `bun run build`, `bun run typecheck`, `bun test` (8 tests), `jq` on JSON output and `pwsh -NoProfile -Command '& ./Invoke-IntuneDeviceNamer.ps1 -Command validate -CliArguments @(...)'` passed. Wizard refuses non-TTY input. No live tenant calls were made; Graph calls in wizard tests are mocked.

## Follow-up: shell launcher

- [x] Add a `sh`-compatible launcher for guided preview and pass-through commands.
- [x] Document invocation and verify the launcher from outside its directory.

Shell launcher review: `/bin/sh -n` passed; `templates` JSON piped to `jq` passed; `validate` invoked from a different directory returned the expected name. Default invocation reached the wizard and correctly refused the non-interactive test terminal. Bun build/type-check and 8 tests passed. No tenant changes were made.

## Follow-up: richer wizard and targeted naming

- [x] Replace readline wizard prompts with Clack, send UI to stderr, show real example names.
- [x] Support targeting one managed-device ID and an explicit dry-run path for apply.
- [x] Verify mocked Graph single-device scenarios, docs, build and PowerShell/shell launchers.

Review: Bun build, strict TypeScript check, 12 tests (including offline dry-run and single-device wizard), shell syntax/JSON piping, and PowerShell validate launcher passed. No tenant credentials or live renames used. Clack is used only for interactive wizard; scriptable commands remain JSON-only.

## Follow-up: infer platform for one device

- [x] Fetch the managed device by ID and derive the platform for its plan; reject unsupported operating systems.
- [x] Skip the platform picker in single-device wizard and show the detected platform and sample names.
- [x] Document ID-only usage and test CLI/wizard paths plus safe apply validation.

Also moved Graph sign-in to the first wizard step and added organization display-name lookup (`Get-MgOrganization` equivalent) with an editable suggested company code; a failed optional lookup leaves manual entry available. Final gate: Bun build, strict type-check, 16 tests, shell launcher syntax/JSON piping, PowerShell launcher, and help all passed. No live tenant requests or rename actions were made.

## Follow-up: PowerShell Graph proxy and device picker

- [x] Implement a persistent PowerShell Graph bridge using Connect-MgGraph and Invoke-MgGraphRequest, with scopes checked on connect and before write.
- [x] Make the wizard default to PowerShell interactive sign-in and select one device from a searchable inventory instead of entering its ID.
- [x] Keep JSON stdout clean, update docs, and test bridge protocol plus wizard and launchers.

Review: `bun run build`, `bun run typecheck`, `bun test` (16 tests), PowerShell launcher `validate`, and shell launcher `templates | jq empty` pass. The PowerShell bridge parses successfully and a local proxy protocol test verifies URL/method guards without signing in. No live tenant Graph calls or renames were made.

## Follow-up: username template and visible custom tokens

- [x] Add Intune UPN-derived `{username}` with missing-user and changed-user protections on apply.
- [x] Show all available tokens beside the wizard's custom input and document CLI examples.
- [x] Verify planning, single-device preview, generated scripts, build and tests.

Final verification: Bun build and strict type-check pass; 21 tests pass, including username normalization, unassigned-user skip, changed-user apply skip and custom token visibility. Username validate output pipes to `jq`; PowerShell and shell launchers pass. The macOS local-script generator explicitly rejects `{username}` because it has no trusted Intune UPN source. No live tenant changes made.

## Follow-up: automatic wizard sign-in

- [x] Connect via PowerShell interactive Graph automatically without asking for authentication mode or app IDs.
- [x] Adjust wizard tests and documentation for the streamlined flow.
- [x] Verify build, type-check, tests, and launchers.

Review: Bun build, strict type-check, 21 tests, PowerShell bridge syntax, PowerShell launcher validation, and shell launcher JSON piping passed. Wizard no longer renders an authentication choice; its Graph connection is automatic and test-injected for offline verification. No live tenant sign-in or rename was performed.

## Follow-up: empty plan filename

- [x] Treat Enter at the save-plan filename prompt as a real default filename.
- [x] If that default already exists, choose the next available numbered plan without overwriting it.
- [x] Document the behavior and run build, type-check, and regression tests (22 passing).

## Follow-up: final confirmation choice

- [x] Replace case-sensitive `APPLY <count>` text entry with a final Confirm / Cancel choice (Cancel default).
- [x] Show the selected action count for both one-device and fleet plans; clearly report cancellation.
- [x] Update docs and tests and run verification.

Review: Bun build, type-check and 22 tests pass. The test checks Confirm/Cancel order, the eligible rename count, cancellation without writes, and the confirmed apply path. Shell and PowerShell launchers pass offline checks; no live rename was attempted.

## Follow-up: explain skipped remote action

- [x] Report which device snapshot or eligibility check caused a skip instead of generic “Device changed.”
- [x] Reflect submitted/skipped/failed results accurately in wizard batch status and exit code.
- [x] Add regression tests and verify build, type-check, tests and docs.

Review: Bun build, strict type-check, and 24 tests pass. Regression coverage checks per-field revalidation reasons, no submitted POST on user drift, and `not-submitted` status with exit code 1 when every action is skipped. No live Graph calls or renames were made during this fix.

## Follow-up: empty enrollment profile false skip

- [x] Normalize empty string/null/undefined for enrollment profile when planning and revalidating.
- [x] Test null versus empty string does not skip, but a real profile change still skips.
- [x] Run build, type checks and tests; document the retry guidance.

Review: build and type-check pass; 24 tests pass with 97 assertions, including null/empty/whitespace no-profile equivalence and real profile-change blocking. Re-run the wizard for a fresh plan and confirm one device; no enrollment profile will be created or modified by this CLI. Live rename not attempted in this session.

## Follow-up: apply saved wizard plan in one command

- [x] Support `apply --auth powershell` using interactive Connect-MgGraph and reuse existing revalidation guards.
- [x] Check signed-in tenant against saved plan and enforce one-device plan shape and `--limit 1` before rename; verify offline dry-run with the actual pilot-4 plan.
- [x] Verify and provide a one-line apply command for the saved plan.

Review: Bun build, type-check, 25 tests and the actual `pilot-4.plan.json` offline dry-run piped to `jq` passed. No live Graph connection or rename was made in this session; the command is ready for the user to execute.

## Follow-up: complete feature documentation

- [x] Audit README against implemented commands, wizard, auth modes, saved plans and platform effects.
- [x] Update README/QUICKSTART and nearby comments with accurate examples and safety behavior.
- [x] Run build, type-check, tests and documentation checks.

Review: README now has a feature matrix, command reference, one-line PowerShell saved-plan apply, status meanings, platform effects and macOS script behavior. Bun build, type-check and 25 tests pass; `pilot-5.plan.json` validates offline with `jq`. No live rename was attempted in this session.

## Follow-up: macOS enrollment-profile label blocks rename

- [x] Apply enrollment-profile revalidation only to iOS/iPadOS, where an ADE name template can overwrite the rename.
- [x] Keep macOS name, serial, ownership, assigned user, platform and collision checks; cover non-empty macOS profile label in tests.
- [x] Update README and verify build/type/tests and the saved plan's offline dry-run.

Review: Bun build, type-check and 25 tests (100 assertions) pass. `pilot-5.plan.json` offline dry-run succeeds. The plan was not submitted from this session; execute the saved-plan command explicitly to request the rename.

## Follow-up: assigned-user department naming

- [x] Add `department-platform-username-serial` preset and `{department}` token using the first two letters of the assigned user's Entra department, without company.
- [x] Resolve Entra department with User.Read.All, snapshot full value, and recheck before apply; skip missing/short department or user ID.
- [x] Show department in custom placeholder guidance; document examples, permissions and local-script limitation.
- [x] Verify Bun build, type-check, 29 tests (111 assertions), PowerShell syntax, and offline `FI-MAC-ALEX-SMITH-C02ABC123456` expansion.

No live tenant renames or Graph department lookups were made during this implementation.

## Follow-up: group-scoped renames

- [x] List Entra security groups and direct device members with paginated Graph reads; match member object IDs to Intune device records.
- [x] Add searchable group scope to wizard and `--group-id` to scripted plan/reconcile, persist group snapshot, and recheck membership before apply.
- [x] Document scope/permissions/limitations and test group filtering, removal, paging, and failure paths; run quality gate.

Review: Bun build, strict type-check, 35 tests (125 assertions), PowerShell proxy syntax, shell launcher help, and PowerShell validation pass. Tests cover group selection, matching Intune records by Entra object ID, empty groups, membership loss, permission failure, and a still-eligible member submitting once. No live tenant changes were made.

## Follow-up: plan folder and cross-directory loading

- [x] Make bare wizard/CLI plan names save to the project's `plans/` directory, with numbered defaults and overwrite prevention.
- [x] Resolve bare `--plan-file` names from `plans/`, with fallback for legacy project-root plans and explicit paths.
- [x] Document paths and verify save/load from another working directory.

Review: Bun build, strict type-check, 38 tests (133 assertions), and shell launcher invocation outside the project directory pass. `plans/.gitkeep` retains the output folder while saved plans remain ignored. No tenant changes were made.
