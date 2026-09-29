#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { authenticate, directory, enrichDepartments, getDevice, getUserDepartment, groupDeviceMembers, groups, inventory, POWERSHELL_TOKEN, requireGuid, setName } from "./graph.ts";
import { connectPowerShell, stopPowerShell } from "./powershell-proxy.ts";
import { eligibility, enrollmentProfile, makePlan, platformOf, render, templateOf, TEMPLATES } from "./naming.ts";
import type { Device, Plan, PlanItem, Platform } from "./naming.ts";
import { interactiveWizard } from "./wizard.ts";
import { planInputPath, preparePlanOutput } from "./plan-paths.ts";

const HELP = `intune-device-namer 1.0.0 — device naming inventory and reconciliation
Usage: bun run src/cli.ts <command> [options]

Commands:
  templates             List built-in templates (offline)
  validate              Expand a template using --platform and --serial (offline)
  inventory             Read Intune devices and Entra names
  plan                  Preview eligible renames; optionally save with --out
  apply                 Apply a saved plan with --plan-file, --confirm and --enable-beta
  wizard                Interactive Clack wizard; PowerShell Graph sign-in and device picker
  reconcile             Preview current drift (alias for plan); never writes
  generate-macos-script Generate an idempotent root-run hostname script to --out

Options:
  --platform <macOS|Windows|iOS|Android|all>  Filter (default: all)
  --template <name|pattern>    Built-in or custom; tokens: {platform}, {serial}, {serial8}, {company}, {username}, {department}
  --company <code>             Alphanumeric company prefix (required for company template)
  --serial <serial>            Example serial for validate
  --username <UPN>            Example Intune userPrincipalName for validate (e.g. alex@contoso.com)
  --department <name>         Example Entra user department for validate (e.g. Finance)
  --device-id <GUID>           Scripted commands: target one managed device (wizard has a picker)
  --group-id <GUID>            Plan/reconcile direct device members of an Entra security group
  --name <name>                Exact new name; only with --device-id and plan/reconcile
  --dry-run                    Preview saved plan without submitting actions (apply)
  --auth <app|device|powershell>  App, device code, or interactive Connect-MgGraph (apply)
  --out <file>                 Save a plan or generated macOS script
  --plan-file <file>           Saved JSON plan for apply
  --confirm                    Required for apply
  --enable-beta                Required for beta setDeviceName Graph action
  --allow-ios-profile          Override potential iOS ADE name-template conflict
  --limit <n>                  Maximum devices for apply (default: 10)
  --help, -h / --version, -v

Environment: TENANT_ID and CLIENT_ID; CLIENT_SECRET additionally for --auth app.
stdout: JSON (except generated script written to --out). stderr: diagnostics. Exit 0/1.
Examples:
  bun run src/cli.ts plan --platform macOS --template platform-serial --out mac.plan.json | jq '.items[]'
  bun run src/cli.ts plan --device-id <Intune-managed-device-GUID> --name MAC-FINANCE-01 --out one.plan.json
  bun run src/cli.ts plan --group-id <Entra-security-group-GUID> --platform macOS --auth app --out group.plan.json
  bun run src/cli.ts apply --plan-file one.plan.json --dry-run
  bun run src/cli.ts apply --plan-file one.plan.json --auth powershell --confirm --enable-beta --limit 1
  bun run src/cli.ts apply --plan-file mac.plan.json --auth app --confirm --enable-beta --limit 5
  bun run src/cli.ts generate-macos-script --template company-platform-serial --company ACME --out mac-rename.sh`;

const OPTIONS = {
  platform: { type: "string" }, template: { type: "string" }, company: { type: "string" }, serial: { type: "string" }, username: { type: "string" }, department: { type: "string" },
  "device-id": { type: "string" }, "group-id": { type: "string" }, "dry-run": { type: "boolean" },
  name: { type: "string" },
  auth: { type: "string" }, out: { type: "string" }, "plan-file": { type: "string" }, limit: { type: "string" },
  confirm: { type: "boolean" }, "enable-beta": { type: "boolean" }, "allow-ios-profile": { type: "boolean" },
  help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
} as const;

function platform(value: string | undefined): Platform | "all" {
  if (value === undefined || value === "all") return "all";
  if (["macOS", "Windows", "iOS", "Android"].includes(value)) return value as Platform;
  throw new Error("--platform must be macOS, Windows, iOS, Android or all.");
}
function companyCode(value: string | undefined): string {
  if (value && !/^[A-Za-z0-9]{1,12}$/.test(value)) throw new Error("--company must be 1–12 ASCII letters or digits.");
  return value ?? "";
}
function output(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function credentials(): { tenant: string; client: string } {
  return { tenant: requireGuid(process.env.TENANT_ID ?? "", "TENANT_ID"), client: requireGuid(process.env.CLIENT_ID ?? "", "CLIENT_ID") };
}
function authMode(value: string | undefined): "app" | "device" {
  if (!value || value === "device") return "device";
  if (value === "app") return "app";
  throw new Error("--auth must be app or device.");
}

async function fetchInventory(token: string): Promise<{ devices: Device[]; entra: Awaited<ReturnType<typeof directory>> }> {
  const [devices, entra] = await Promise.all([inventory(token), directory(token)]);
  for (const device of devices) if (device.azureADDeviceId) device.joinType = entra.get(device.azureADDeviceId.toLowerCase())?.trustType;
  return { devices, entra };
}

function isPlan(value: unknown): value is Plan {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return p.schemaVersion === 1 && typeof p.tenantId === "string" && typeof p.template === "string" && typeof p.company === "string" &&
    (p.deviceId === undefined || typeof p.deviceId === "string") &&
    (p.group === undefined || (typeof p.group === "object" && p.group !== null && typeof (p.group as Record<string, unknown>).id === "string" && typeof (p.group as Record<string, unknown>).displayName === "string")) &&
    !(p.deviceId && p.group) &&
    ["macOS", "Windows", "iOS", "Android", "all"].includes(String(p.platform)) && Array.isArray(p.items) && p.items.every((i: unknown) => {
      if (!i || typeof i !== "object") return false;
      const item = i as Record<string, unknown>;
      return typeof item.id === "string" && typeof item.currentName === "string" && typeof item.serialNumber === "string" &&
        ["rename", "skip", "unchanged"].includes(String(item.action)) && typeof item.platform === "string" &&
        (item.userPrincipalName === undefined || item.userPrincipalName === null || typeof item.userPrincipalName === "string") &&
        (item.userId === undefined || item.userId === null || typeof item.userId === "string") &&
        (item.department === undefined || item.department === null || typeof item.department === "string") &&
        (item.enrollmentProfileName === null || typeof item.enrollmentProfileName === "string") &&
        (item.proposedName === null || typeof item.proposedName === "string");
    });
}

export function revalidationReason(item: PlanItem, current: Device, plan: Plan, allowIosProfile: boolean, allDevices: Device[]): string | null {
  const os = platformOf(current.operatingSystem);
  if (os === "unsupported") return `Unsupported current platform: ${current.operatingSystem}.`;
  if (os !== item.platform || (plan.platform !== "all" && os !== plan.platform))
    return `Platform changed: planned ${item.platform}, current ${os}. Create a new plan.`;
  const ineligible = eligibility(current, os, allowIosProfile);
  if (ineligible) return ineligible;
  if (current.deviceName === item.proposedName) return "Already has the proposed name; no action needed.";
  if (current.deviceName !== item.currentName)
    return `Device name changed: planned '${item.currentName}', current '${current.deviceName}'. Create a new plan.`;
  if (current.serialNumber === undefined || current.serialNumber === null)
    return "Intune did not return the device serial number during recheck. No action submitted; try again after a sync.";
  if (current.serialNumber !== item.serialNumber)
    return `Serial number changed: planned '${item.serialNumber}', current '${current.serialNumber}'. Create a new plan.`;
  if (plan.template.includes("{username}")) {
    if ((current.userId ?? null) !== item.userId) return "Assigned Intune user ID changed since preview. Create a new plan.";
    if ((current.userPrincipalName ?? null) !== item.userPrincipalName) return "Assigned Intune username changed since preview. Create a new plan.";
  }
  if (plan.template.includes("{department}")) {
    if ((current.userId ?? null) !== item.userId) return "Assigned Intune user ID changed since preview. Create a new plan.";
    if ((current.userPrincipalName ?? null) !== item.userPrincipalName) return "Assigned Intune username changed since preview. Create a new plan.";
    if ((current.department ?? null) !== item.department) return "Assigned user's Entra department changed since preview. Create a new plan.";
  }
  // iOS ADE naming templates can overwrite a rename on check-in. The profile label is
  // not a naming constraint for macOS/Windows/Android and list/get can report it differently.
  if (os === "iOS" && enrollmentProfile(current.enrollmentProfileName) !== enrollmentProfile(item.enrollmentProfileName))
    return "Enrollment profile changed since preview. Create a new plan.";
  let proposed: string;
  try { proposed = render(plan.template, os, current.serialNumber ?? "", plan.company, current.userPrincipalName, current.department); }
  catch (error) { return `Cannot generate the proposed name: ${error instanceof Error ? error.message : String(error)}`; }
  if (proposed !== item.proposedName) return `Proposed name changed: planned '${item.proposedName}', current calculation '${proposed}'. Create a new plan.`;
  if (allDevices.some(d => d.id !== item.id && d.deviceName?.toLowerCase() === proposed.toLowerCase()))
    return `Name collision: another Intune device already uses '${proposed}'.`;
  return null;
}

export async function applyPlan(plan: Plan, token: string, limit: number, allowIosProfile: boolean): Promise<{ results: { id: string; status: string; reason: string }[] }> {
  templateOf(plan.template);
  companyCode(plan.company);
  platform(plan.platform);
  const selected = plan.items.filter(i => i.action === "rename");
  if ((plan.template.includes("{username}") || plan.template.includes("{department}")) && selected.some(i => i.userPrincipalName === undefined || i.userId === undefined)) {
    throw new Error("User-based plan lacks a saved Intune user snapshot; generate a new plan.");
  }
  if (plan.template.includes("{department}") && selected.some(i => i.department === undefined)) {
    throw new Error("Department plan lacks a saved Entra department snapshot; generate a new plan.");
  }
  if (plan.deviceId && plan.items.some(i => i.id.toLowerCase() !== plan.deviceId?.toLowerCase())) throw new Error("Plan device ID does not match entries.");
  if (plan.group) requireGuid(plan.group.id, "plan group ID");
  if (selected.some(i => !["macOS", "Windows", "iOS", "Android"].includes(i.platform))) throw new Error("Plan contains an invalid platform.");
  if (selected.some(i => i.proposedName === null)) throw new Error("Plan contains rename entries without a name.");
  if (selected.length > limit) throw new Error(`Plan has ${selected.length} renames, exceeds --limit ${limit}; increase deliberately or narrow the plan.`);
  if (new Set(selected.map(i => i.id)).size !== selected.length) throw new Error("Duplicate device IDs in plan.");
  if (new Set(selected.map(i => i.proposedName?.toLowerCase())).size !== selected.length) throw new Error("Duplicate target names in plan.");
  const iOSProfiles = selected.filter(i => i.platform === "iOS" && i.enrollmentProfileName);
  if (iOSProfiles.length && !allowIosProfile) throw new Error("iOS devices with enrollment profiles require --allow-ios-profile after policy review.");
  const results: { id: string; status: string; reason: string }[] = [];
  const [entra, allDevices, members] = await Promise.all([directory(token), inventory(token), plan.group ? groupDeviceMembers(token, plan.group.id) : Promise.resolve(null)]);
  // Sequential actions intentionally limit the remote-action rate; each device is rechecked before submission.
  for (const item of selected) {
    try {
      const current = await getDevice(token, item.id);
      if (plan.template.includes("{department}")) current.department = current.userId ? await getUserDepartment(token, current.userId) : null;
      if (current.azureADDeviceId) current.joinType = entra.get(current.azureADDeviceId.toLowerCase())?.trustType;
      const reason = revalidationReason(item, current, plan, allowIosProfile, allDevices);
      const objectId = current.azureADDeviceId ? entra.get(current.azureADDeviceId.toLowerCase())?.id.toLowerCase() : undefined;
      const groupReason = members && (!objectId || !members.has(objectId)) ? "Device is no longer a direct member of the selected Entra group; no rename submitted." : null;
      if (reason || groupReason || (platformOf(current.operatingSystem) === "Windows" && current.azureADDeviceId && !entra.has(current.azureADDeviceId.toLowerCase()))) {
        results.push({ id: item.id, status: "skipped", reason: reason ?? groupReason ?? "Cannot confirm Windows join type in Entra; hybrid-joined devices are unsupported." });
        continue;
      }
      // revalidationReason checks the expanded name, including assigned-user drift.
      await setName(token, item.id, item.proposedName!);
      results.push({ id: item.id, status: "submitted", reason: "Graph accepted remote action; verify after device check-in." });
    } catch (error) {
      results.push({ id: item.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results };
}

function macScript(template: string, company: string): string {
  // Restrict embedded values to avoid shell expansion or injection. macOS script takes its own serial locally.
  const checked = templateOf(template);
  if (checked.includes("{username}")) throw new Error("macOS local script cannot read Intune's assigned username; use a serial-based template or Intune remote rename.");
  if (checked.includes("{department}")) throw new Error("macOS local script cannot read the assigned user's Entra department; use a serial-based template or Intune remote rename.");
  if (!/^[A-Za-z0-9{}-]+$/.test(checked) || !/^[A-Za-z0-9]{0,12}$/.test(company)) throw new Error("macOS script supports only alphanumeric/hyphen literals and safe company codes.");
  render(checked, "macOS", "ABCDEFGH123456", company);
  const pattern = checked.toUpperCase().replaceAll("{PLATFORM}", "MAC").replaceAll("{COMPANY}", company.toUpperCase())
    .replaceAll("{SERIAL8}", "{serial8}").replaceAll("{SERIAL}", "{serial}");
  if (!pattern.includes("{serial}") && !pattern.includes("{serial8}")) throw new Error("macOS script requires a serial token for unique names.");
  if (pattern.includes("{serial8}")) console.error("Warning: {serial8} can collide across devices; check inventory before deployment.");
  return `#!/bin/sh
set -eu
# Deploy with Intune macOS shell scripts: run as signed-in user No (root); scheduled frequency for reconciliation.
serial=$(ioreg -l | /usr/bin/awk -F '"' '/IOPlatformSerialNumber/ { print $4; exit }')
serial=$(printf '%s' "$serial" | /usr/bin/tr '[:lower:]' '[:upper:]')
case "$serial" in ''|*[!A-Z0-9-]*) echo 'Invalid serial' >&2; exit 1;; esac
[ "\${#serial}" -ge 8 ] || { echo 'Serial too short' >&2; exit 1; }
short=$(printf '%s' "$serial" | /usr/bin/tail -c 8)
pattern='${pattern}'
name=$(printf '%s' "$pattern" | /usr/bin/sed "s/{serial8}/$short/g;s/{serial}/$serial/g")
case "$name" in ''|*[!A-Z0-9-]*|-*|*-) echo 'Invalid name' >&2; exit 1;; esac
[ "\${#name}" -ge 1 ] || exit 1
case "$name" in *[A-Z]*) : ;; *) echo 'Name requires a letter' >&2; exit 1;; esac
[ "\${#name}" -le 63 ] || { echo 'Name exceeds 63 characters' >&2; exit 1; }
for kind in ComputerName LocalHostName HostName; do
  current=$(/usr/sbin/scutil --get "$kind" 2>/dev/null || true)
  [ "$current" = "$name" ] || /usr/sbin/scutil --set "$kind" "$name"
done
echo "$name"
`;
}

async function main(): Promise<void> {
  const { values: v, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: OPTIONS });
  const command = positionals[0];
  if (v.help || !command || command === "help") { console.log(HELP); return; }
  if (v.version || command === "version") { console.log("1.0.0"); return; }
  if (positionals.length !== 1) throw new Error("Expected exactly one command. Use --help.");
  const chosenPlatform = platform(v.platform);
  const company = companyCode(v.company);
  const template = templateOf(v.template ?? "platform-serial");
  const deviceId = v["device-id"] ? requireGuid(v["device-id"], "--device-id") : undefined;
  const groupId = v["group-id"] ? requireGuid(v["group-id"], "--group-id") : undefined;
  if (deviceId && groupId) throw new Error("Choose either --device-id or --group-id.");
  if (groupId && !["plan", "reconcile"].includes(command)) throw new Error("--group-id is supported only for plan and reconcile; apply reads the saved group scope.");
  if (v.name !== undefined && (!deviceId || !["plan", "reconcile"].includes(command))) throw new Error("--name requires --device-id with plan or reconcile.");
  if (v["dry-run"] && command !== "apply") throw new Error("--dry-run is only used with apply; plan/reconcile/wizard preview by default.");
  if (deviceId && !["inventory", "plan", "reconcile", "apply", "wizard"].includes(command)) throw new Error("--device-id applies only to inventory, plan, reconcile, apply, or wizard.");
  if (command === "templates") { output(TEMPLATES); return; }
  if (command === "wizard") {
    if (deviceId) throw new Error("The wizard selects a device from a searchable list; omit --device-id.");
    output(await interactiveWizard({ enableBeta: v["enable-beta"] ?? false, allowIosProfile: v["allow-ios-profile"] ?? false }, applyPlan)); return;
  }
  if (command === "validate") {
    if (chosenPlatform === "all" || !v.serial) throw new Error("validate requires --platform and --serial.");
    output({ template, platform: chosenPlatform, name: render(template, chosenPlatform, v.serial, company, v.username, v.department) }); return;
  }
  if (command === "generate-macos-script") {
    if (!v.out) throw new Error("generate-macos-script requires --out.");
    const script = macScript(template, company);
    await writeFile(v.out, script, { flag: "wx", mode: 0o700 });
    output({ file: v.out, template, deployment: "Intune > Devices > macOS > Scripts; run as root, assign to a scoped device group." }); return;
  }
  if (!["inventory", "plan", "reconcile", "apply"].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === "apply") {
    if (!v["plan-file"] || (!v["dry-run"] && (!v.confirm || !v["enable-beta"]))) throw new Error("apply requires --plan-file; writes additionally require --confirm and --enable-beta.");
    const limit = Number(v.limit ?? "10");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
    const raw: unknown = JSON.parse(await readFile(await planInputPath(v["plan-file"]), "utf8"));
    if (!isPlan(raw)) throw new Error("Invalid plan.");
    if (raw.deviceId && (raw.items.length !== 1 || raw.items[0]?.id.toLowerCase() !== raw.deviceId.toLowerCase())) throw new Error("Single-device plan must contain exactly its target device.");
    if (deviceId && (raw.deviceId?.toLowerCase() !== deviceId.toLowerCase() || raw.items.some(i => i.id.toLowerCase() !== deviceId.toLowerCase()))) throw new Error("Plan does not target only --device-id.");
    if (v["dry-run"]) {
      const configuredTenant = process.env.TENANT_ID;
      if (configuredTenant && requireGuid(configuredTenant, "TENANT_ID").toLowerCase() !== raw.tenantId.toLowerCase()) throw new Error("Plan tenant does not match TENANT_ID.");
      output({ status: "dry-run", plan: raw }); return;
    }
    if (v.auth === "powershell") {
      try {
        // Reuse the wizard's delegated Graph path for a previously saved plan. Tenant,
        // one-device scope, batch limit, and live snapshots are checked before any POST.
        const connection = await connectPowerShell();
        if (raw.tenantId.toLowerCase() !== connection.tenantId.toLowerCase()) throw new Error("Plan tenant mismatch; no rename was submitted.");
        const result = await applyPlan(raw, POWERSHELL_TOKEN, limit, v["allow-ios-profile"] ?? false);
        output(result);
        if (result.results.some(r => r.status !== "submitted")) process.exitCode = 1;
      } finally { await stopPowerShell(); }
    } else {
      const { tenant, client } = credentials();
      if (raw.tenantId.toLowerCase() !== tenant.toLowerCase()) throw new Error("Plan tenant mismatch.");
      const token = await authenticate(tenant, client, authMode(v.auth), true);
      const result = await applyPlan(raw, token, limit, v["allow-ios-profile"] ?? false);
      output(result);
      if (result.results.some(r => r.status !== "submitted")) process.exitCode = 1;
    }
    return;
  }
  const { tenant, client } = credentials();
  const token = await authenticate(tenant, client, authMode(v.auth), false);
  const { devices, entra } = await fetchInventory(token);
  if (command === "inventory") {
    const matches = devices.filter(d => !deviceId
      ? chosenPlatform === "all" || platformOf(d.operatingSystem) === chosenPlatform
      : d.id.toLowerCase() === deviceId.toLowerCase());
    if (deviceId && !matches.length) throw new Error("Managed device not found.");
    output(matches.map(d => ({
      ...d, entraName: d.azureADDeviceId ? entra.get(d.azureADDeviceId.toLowerCase())?.displayName ?? null : null,
    }))); return;
  }
  const selectedGroup = groupId ? (await groups(token)).find(g => g.id.toLowerCase() === groupId.toLowerCase()) : undefined;
  if (groupId && !selectedGroup) throw new Error("Security group not found or not readable.");
  const members = groupId ? await groupDeviceMembers(token, groupId) : undefined;
  const selectedDevices = groupId ? devices.filter(d => d.azureADDeviceId && entra.has(d.azureADDeviceId.toLowerCase()) && members?.has(entra.get(d.azureADDeviceId.toLowerCase())!.id.toLowerCase())) : devices;
  await enrichDepartments(token, selectedDevices.filter(d => !deviceId || d.id.toLowerCase() === deviceId.toLowerCase()), v.name ?? template);
  const plan = makePlan(devices, entra, { tenantId: tenant, template: v.name ?? template, platform: chosenPlatform, company, allowIosProfile: v["allow-ios-profile"] ?? false, deviceId,
    ...(selectedGroup ? { group: { id: selectedGroup.id, displayName: selectedGroup.displayName }, groupMemberIds: members } : {}) });
  if (v.out) await writeFile(await preparePlanOutput(v.out), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  output(plan);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
