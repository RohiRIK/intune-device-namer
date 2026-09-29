import { writeFile } from "node:fs/promises";

import * as clack from "@clack/prompts";

import { directory, enrichDepartments, getDevice, groupDeviceMembers, groups, inventory, organizationName, POWERSHELL_TOKEN } from "./graph.ts";
import { connectPowerShell, stopPowerShell } from "./powershell-proxy.ts";
import { companySuggestion, makePlan, platformOf, render, templateOf, TEMPLATES } from "./naming.ts";
import type { Plan, Platform } from "./naming.ts";
import { planOutputPath, preparePlanOutput } from "./plan-paths.ts";

export type Apply = (plan: Plan, token: string, limit: number, allowIosProfile: boolean) => Promise<{ results: { id: string; status: string; reason: string }[] }>;
export type PromptUI = {
  select(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string>;
  search(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string>;
  text(message: string, placeholder?: string, initialValue?: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
  note(message: string, title: string): void;
};

function result<T>(answer: T | symbol): T {
  if (clack.isCancel(answer)) throw new Error("Wizard cancelled.");
  return answer as T;
}

type WizardConnection = { tenantId: string; account: string; token: string };

/** Enter saves under plans/; collisions get numbered names without overwriting a plan. */
export async function savePlan(plan: Plan, requested: string, defaultPath = "pilot.plan.json"): Promise<string> {
  const path = planOutputPath(requested.trim() || defaultPath);
  const isDefault = !requested.trim();
  for (let number = 1; number <= 1000; number++) {
    const candidate = isDefault && number > 1
      ? path.replace(/(\.plan\.json)$/i, `-${number}$1`)
      : path;
    try {
      await preparePlanOutput(candidate);
      await writeFile(candidate, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return candidate;
    } catch (error) {
      if (!isDefault || !isFileExists(error)) throw error;
    }
  }
  throw new Error("No free default plan filename found; enter a new filename.");
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function connectWizard(): Promise<WizardConnection> {
  const connection = await connectPowerShell();
  return { ...connection, token: POWERSHELL_TOKEN };
}

export async function runWizard(options: { enableBeta: boolean; allowIosProfile: boolean }, prompts: PromptUI, apply: Apply, connect: () => Promise<WizardConnection> = connectWizard): Promise<unknown> {
  const { tenantId: tenant, account, token } = await connect();
  prompts.note(`${account} · tenant ${tenant}`, "Connected to Graph");
  let orgName: string | null = null;
  try { orgName = await organizationName(token); }
  catch (error) { prompts.note(`Couldn't read organization name: ${error instanceof Error ? error.message : String(error)}. Enter a company code manually if needed.`, "Organization lookup"); }
  const suggested = orgName ? companySuggestion(orgName) : "";
  if (orgName) prompts.note(`${orgName}${suggested ? ` → suggested code ${suggested}` : " (no valid code could be derived)"}`, "Microsoft Entra organization");
  const [devices, entra] = await Promise.all([inventory(token), directory(token)]);
  for (const device of devices) if (device.azureADDeviceId) device.joinType = entra.get(device.azureADDeviceId.toLowerCase())?.trustType;
  const scope = await prompts.select("Device scope", [
    { value: "all", label: "All devices", hint: "Filter by platform next" },
    { value: "one", label: "One device", hint: "Search the Intune device inventory" },
    { value: "group", label: "Entra device group", hint: "Direct Intune-managed device members" },
  ]);
  if (scope === "one" && !devices.length) throw new Error("No Intune managed devices are visible to this account.");
  const deviceId = scope === "one" ? await prompts.search("Search devices by name, serial or platform", devices.map(d => ({
    value: d.id, label: `${d.deviceName || "Unnamed"} · ${d.operatingSystem}`, hint: d.serialNumber || d.id,
  }))) : undefined;
  const availableGroups = scope === "group" ? await groups(token) : [];
  if (scope === "group" && !availableGroups.length) throw new Error("No Entra security groups are visible to this account.");
  const groupId = scope === "group" ? await prompts.search("Search Entra security groups", availableGroups.map(group => ({
    value: group.id, label: group.displayName, hint: group.id,
  }))) : undefined;
  const selectedGroup = groupId ? availableGroups.find(group => group.id === groupId) : undefined;
  if (groupId && !selectedGroup) throw new Error("Selected Entra security group was not found.");
  const members = groupId ? await groupDeviceMembers(token, groupId) : undefined;
  const groupDevices = groupId ? devices.filter(device => device.azureADDeviceId && entra.has(device.azureADDeviceId.toLowerCase()) && members?.has(entra.get(device.azureADDeviceId.toLowerCase())!.id.toLowerCase())) : devices;
  if (selectedGroup) prompts.note(`${selectedGroup.displayName}: ${members?.size ?? 0} direct Entra device members; ${groupDevices.length} matched Intune-managed devices.`, "Group scope");
  const selectedPlatform = deviceId ? undefined : await prompts.select("Platform filter", ["macOS", "Windows", "iOS", "Android", "all"].map(value => ({ value, label: value }))) as Platform | "all";
  const target = deviceId ? await getDevice(token, deviceId) : undefined;
  if (deviceId && !target) throw new Error("Selected device is not in the Intune inventory.");
  if (target && target.id.toLowerCase() !== deviceId?.toLowerCase()) throw new Error("Graph returned a different managed device ID.");
  const detected = target ? platformOf(target.operatingSystem) : undefined;
  if (detected === "unsupported") throw new Error(`Unsupported operating system for managed device ${deviceId}: ${target?.operatingSystem}.`);
  const platform = detected ?? selectedPlatform ?? "all";
  if (target) prompts.note(`${target.deviceName} · ${platform} · serial ${target.serialNumber || "unavailable"}`, "Detected Intune device");
  const serial = target && /^[A-Z0-9-]+$/i.test(target.serialNumber ?? "") && (target.serialNumber ?? "").length >= 8 ? target.serialNumber : "C02ABC123456";
  if (target && serial !== target.serialNumber) prompts.note("The selected device has no usable serial; examples below use an illustrative serial. Serial-based templates will be skipped in the plan.", "Serial unavailable");
  const examplePlatform = platform === "all" ? "macOS" : platform;
  const exampleUser = target?.userPrincipalName?.includes("@") ? target.userPrincipalName : "alex.smith@contoso.com";
  // The menu uses an illustrative department; the actual Entra value is fetched only
  // when a department-based template is selected and is shown in the final preview.
  const exampleDepartment = "Finance";
  if (target && !target.userPrincipalName?.includes("@")) prompts.note("No usable assigned Intune username is available for this device. Username-based templates will be skipped; examples use an illustrative user.", "Username unavailable");
  const tokenGuide = [
    `{platform} → ${render("{platform}", examplePlatform, "", "")}`,
    `{serial} → ${serial}`,
    `{serial8} → ${serial.slice(-8)}`,
    `{company} → ${suggested || "ACME"} (editable)`,
    `{username} → ${render("{username}", examplePlatform, "", "", exampleUser)} (Intune userPrincipalName before @)`,
    `{department} → ${render("{department}", examplePlatform, "", "", exampleUser, exampleDepartment)} (first two letters of assigned user's Entra department)`,
  ].join("\n");
  prompts.note(tokenGuide, "Naming placeholders (custom patterns)");
  const samples = Object.entries(TEMPLATES).map(([value, pattern]) => ({
    value, label: `${value} → ${render(pattern, examplePlatform, serial, suggested || "ACME", exampleUser, exampleDepartment)}`,
    hint: value === "compact-serial" ? "Shorter serial; check collisions" : undefined,
  }));
  const selected = await prompts.select(`Naming format (examples use ${examplePlatform} and serial ${serial})`, [
    ...samples, { value: "custom", label: "Custom pattern", hint: `Example: HQ-{platform}-{serial} → ${render("HQ-{platform}-{serial}", examplePlatform, serial, "")}` },
    ...(deviceId ? [{ value: "exact", label: "Exact device name", hint: "Example: MAC-FINANCE-01 (this device only)" }] : []),
  ]);
  if (selected === "custom") prompts.note(`${tokenGuide}\n\nExample: {department}-{platform}-{username}-{serial}\n→ ${render("{department}-{platform}-{username}-{serial}", examplePlatform, serial, "", exampleUser, exampleDepartment)}`, "All custom placeholders");
  const template = templateOf(selected === "exact"
    ? (await prompts.text("Exact new device name", "MAC-FINANCE-01")).trim()
    : selected === "custom" ? (await prompts.text("Custom: {platform} {serial} {serial8} {company} {username} {department}", "HQ-{platform}-{serial}")).trim() : selected);
  const company = template.includes("{company}") ? (await prompts.text("Company code (edit suggested value if needed)", suggested || "ACME", suggested)).trim() : "";
  if (company && !/^[A-Za-z0-9]{1,12}$/.test(company)) throw new Error("Company code must be 1–12 letters or digits.");
  if (template.includes("{company}") && !company) throw new Error("Company code is required.");
  if (template.includes("{department}")) {
    await enrichDepartments(token, deviceId ? devices.filter(d => d.id === deviceId) : groupDevices.filter(d => platform === "all" || platformOf(d.operatingSystem) === platform), template);
    if (target) {
      target.department = devices.find(d => d.id === target.id)?.department ?? null;
      if (!target.department) prompts.note("This device has no readable assigned-user department. It will be skipped; check the Entra department and User.Read.All permission.", "Department unavailable");
    }
  }
  const shownDepartment = target?.department || exampleDepartment;
  if (target && !target.department && template.includes("{department}")) prompts.note("This example uses Finance; the selected device has no department and the plan will skip it.", "Illustrative department");
  prompts.note(platform === "all"
    ? ["macOS", "Windows", "iOS", "Android"].map(p => `${p}: ${render(template, p as Platform, serial, company, exampleUser, shownDepartment)}`).join("\n")
    : render(template, platform, serial, company, exampleUser, shownDepartment), "Example name (illustrative inputs)");
  const plan = makePlan(devices, entra, { tenantId: tenant, template, platform, company, allowIosProfile: options.allowIosProfile, deviceId,
    ...(selectedGroup ? { group: { id: selectedGroup.id, displayName: selectedGroup.displayName }, groupMemberIds: members } : {}) });
  const changes = plan.items.filter(item => item.action === "rename");
  prompts.note(`${plan.items.length} devices · ${changes.length} renames · ${plan.items.filter(i => i.action === "skip").length} skipped\n${changes.slice(0, 10).map(i => `${i.currentName} → ${i.proposedName}`).join("\n") || "No eligible renames"}${changes.length > 10 ? "\n… see JSON for the complete plan" : ""}`, "Dry-run preview");
  let file: string | null = null;
  if (await prompts.confirm("Save plan to a new file?")) {
    file = await savePlan(plan, await prompts.text("New plan filename (Enter saves to plans/pilot.plan.json)", "pilot.plan.json"));
    prompts.note(file, "Saved plan");
  }
  if (!changes.length || !file || !options.enableBeta) return { status: "preview", planFile: file, plan };
  const decision = await prompts.select(`Ready to submit ${changes.length} Intune rename action${changes.length === 1 ? "" : "s"}?`, [
    { value: "cancel", label: "Cancel", hint: "Keep the saved plan; no device changes" },
    { value: "confirm", label: `Confirm ${changes.length} rename${changes.length === 1 ? "" : "s"}`, hint: "Submit via Microsoft Graph beta" },
  ]);
  if (decision !== "confirm") {
    prompts.note(`No rename actions submitted. Review ${file} or run the wizard again when ready.`, "Cancelled");
    return { status: "preview", planFile: file, plan };
  }
  const applied = await apply(plan, token, changes.length, options.allowIosProfile);
  const submitted = applied.results.filter(entry => entry.status === "submitted").length;
  const skipped = applied.results.filter(entry => entry.status === "skipped").length;
  const failed = applied.results.filter(entry => entry.status === "failed").length;
  const status = submitted === 0 ? "not-submitted" : skipped || failed ? "partial" : "submitted";
  prompts.note(`${submitted} submitted · ${skipped} skipped · ${failed} failed${skipped || failed ? "\nReview the per-device reasons in the JSON results." : "\nVerify the device name after check-in."}`, "Rename results");
  if (status !== "submitted") process.exitCode = 1;
  return { status, planFile: file, plan, ...applied };
}

export async function interactiveWizard(options: { enableBeta: boolean; allowIosProfile: boolean }, apply: Apply): Promise<unknown> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("wizard requires an interactive terminal (stdin and stderr); use plan for pipelines.");
  // Clack normally renders to stdout; explicitly route its UI to stderr to preserve JSON stdout.
  clack.intro("Intune device naming · dry-run first", { output: process.stderr });
  const prompts: PromptUI = {
    select: async (message, options) => result<string>(await clack.select({ message, options, output: process.stderr })),
    search: async (message, options) => result<string>(await clack.autocomplete({ message, options, output: process.stderr })),
    text: async (message, placeholder, initialValue) => result<string>(await clack.text({ message, placeholder, initialValue, output: process.stderr })),
    confirm: async message => result<boolean>(await clack.confirm({ message, initialValue: false, output: process.stderr })),
    note: (message, title) => { clack.note(message, title, { output: process.stderr }); },
  };
  try {
    const result = await runWizard(options, prompts, apply);
    clack.outro("Finished · review JSON results", { output: process.stderr });
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "Wizard cancelled.") clack.cancel("No changes submitted", { output: process.stderr });
    throw error;
  } finally { await stopPowerShell(); }
}
