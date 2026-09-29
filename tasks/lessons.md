# Lessons

- When a user expects a CLI wizard, distinguish interactive guidance from the existing `--help` and command flow; provide an actual guided entry point and a convenient launcher rather than treating command examples as a wizard.
- A wizard should display concrete expanded name examples before asking for a template, and provide an explicit single-device path with preview and guarded apply.
- When an ID uniquely identifies a managed device, derive the platform from the fetched record instead of asking for a redundant platform filter; ensure the saved plan records that derived platform.
- When the user asks to use an existing interactive Graph sign-in pattern, avoid asking them to register a new client app or paste device IDs; bridge to their PowerShell Graph session and let them select a discovered device by name.
- Show all supported custom naming placeholders adjacent to the custom pattern input, not only in README or a hidden help screen.
- When the user says they do not need authentication choices in an interactive wizard, sign in with the established default directly instead of retaining a redundant sign-in menu.
- A prompt's placeholder is only a hint, not a default value: an empty Enter response must resolve to a real filename before saving, without overwriting existing plans.
- Typed confirmations that require exact casing are easy to misread; use an explicit final Confirm/Cancel choice with Cancel selected by default, and report cancellation clearly.
- Do not call a batch `applied` if every remote action was skipped; explain which revalidation check blocked each device and reserve success language for actions actually submitted.
- Microsoft Graph can return an absent property as null/undefined in one response and an empty string in another; normalize equivalent "no value" states before snapshot comparison, while still detecting actual changes.
