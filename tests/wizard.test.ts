import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWizard, savePlan } from "../src/wizard.ts";
import type { Apply, PromptUI } from "../src/wizard.ts";
import type { Plan } from "../src/naming.ts";
import { planInputPath, planOutputPath, plansDirectory, preparePlanOutput } from "../src/plan-paths.ts";

const tenant = "11111111-1111-1111-1111-111111111111";
const client = "22222222-2222-2222-2222-222222222222";
const connect = async (): Promise<{ tenantId: string; account: string; token: string }> => ({ tenantId: tenant, account: "admin@contoso.com", token: "test-token" });
const nativeFetch = globalThis.fetch;
const previous = { TENANT_ID: process.env.TENANT_ID, CLIENT_ID: process.env.CLIENT_ID, CLIENT_SECRET: process.env.CLIENT_SECRET };

function responses(): void {
  process.env.TENANT_ID = tenant;
  process.env.CLIENT_ID = client;
  process.env.CLIENT_SECRET = "test-only";
  const fakeFetch = async (request: RequestInfo | URL): Promise<Response> => {
    const url = String(request);
    if (url.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "test-token" });
    if (url.includes("/managedDevices/33333333-3333-3333-3333-333333333333?")) return Response.json({ id: "33333333-3333-3333-3333-333333333333", deviceName: "OldMac", serialNumber: "C02ABC123456", operatingSystem: "macOS", managedDeviceOwnerType: "company", userPrincipalName: "alex.smith@contoso.com", userId: "44444444-4444-4444-4444-444444444444" });
    if (url.includes("/managedDevices?")) return Response.json({ value: [{ id: "33333333-3333-3333-3333-333333333333", deviceName: "OldMac", serialNumber: "C02ABC123456", operatingSystem: "macOS", managedDeviceOwnerType: "company", userPrincipalName: "alex.smith@contoso.com", userId: "44444444-4444-4444-4444-444444444444" }] });
    if (url.includes("/organization?")) return Response.json({ value: [{ displayName: "Global Tradé Ltd" }] });
    if (url.includes("/v1.0/groups?")) return Response.json({ value: [{ id: "66666666-6666-6666-6666-666666666666", displayName: "Mac Pilot", securityEnabled: true }] });
    if (url.includes("/groups/66666666-6666-6666-6666-666666666666/members")) return Response.json({ value: [{ id: "77777777-7777-7777-7777-777777777777", "@odata.type": "#microsoft.graph.device" }] });
    if (url.includes("/users/44444444-4444-4444-4444-444444444444?")) return Response.json({ department: "Finance" });
    if (url.includes("/v1.0/devices?")) return Response.json({ value: [{ id: "77777777-7777-7777-7777-777777777777", deviceId: "99999999-9999-9999-9999-999999999999", displayName: "OldMac" }] });
    throw new Error(`Unexpected request: ${url}`);
  };
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
}

function responsesWithoutOrg(): void {
  responses();
  const withOrg = globalThis.fetch;
  const fakeFetch = async (request: RequestInfo | URL): Promise<Response> => {
    if (String(request).includes("/organization?")) return new Response("Forbidden", { status: 403 });
    return withOrg(request);
  };
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
}

function answers(...values: (string | boolean)[]): PromptUI {
  let index = 0;
  const next = (): string | boolean => {
    const value = values[index++];
    if (value === undefined) throw new Error("Wizard asked an unexpected question.");
    return value;
  };
  return {
    select: async () => String(next()),
    search: async () => String(next()),
    text: async () => String(next()),
    confirm: async () => Boolean(next()),
    note: () => {},
  };
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const key of Object.keys(previous) as (keyof typeof previous)[]) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("wizard safeguards", () => {
  test("Enter saves to the default filename and a second save picks an unused name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "namer-default-"));
    const defaultPath = join(directory, "pilot.plan.json");
    const plan: Plan = { schemaVersion: 1, tenantId: tenant, template: "{platform}-{serial}", platform: "macOS", company: "", items: [] };
    try {
      expect(await savePlan(plan, "", defaultPath)).toBe(defaultPath);
      const second = join(directory, "pilot-2.plan.json");
      expect(await savePlan(plan, "", defaultPath)).toBe(second);
      expect(JSON.parse(await readFile(defaultPath, "utf8"))).toMatchObject(plan);
      expect(JSON.parse(await readFile(second, "utf8"))).toMatchObject(plan);
      await expect(savePlan(plan, defaultPath, defaultPath)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("bare plan names save to plans/ and can be resolved from another cwd", async () => {
    const filename = `namer-test-${crypto.randomUUID()}.plan.json`;
    const plan: Plan = { schemaVersion: 1, tenantId: tenant, template: "{platform}-{serial}", platform: "macOS", company: "", items: [] };
    const path = planOutputPath(filename);
    try {
      expect(path).toBe(join(plansDirectory, filename));
      expect(await savePlan(plan, filename)).toBe(path);
      expect(await planInputPath(filename)).toBe(path);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(plan);
    } finally { await rm(path, { force: true }); }
  });
  test("explicit paths remain explicit and old root plans remain readable", async () => {
    const filename = `legacy-namer-${crypto.randomUUID()}.plan.json`;
    const path = join(import.meta.dir, "..", filename);
    try {
      await writeFile(path, "{}");
      expect(await planInputPath(filename)).toBe(path);
      expect(await preparePlanOutput(path)).toBe(path);
    } finally { await rm(path, { force: true }); }
  });
  test("defaults to preview, never invokes apply without beta opt-in", async () => {
    responses();
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const prompts = answers("all", "macOS", "platform-serial", false);
    const select = prompts.select;
    prompts.select = (message, options) => {
      expect(message).not.toMatch(/Connect|sign-in|credentials/i);
      return select(message, options);
    };
    const result = await runWizard({ enableBeta: false, allowIosProfile: false }, prompts, apply, connect);
    expect(result).toMatchObject({ status: "preview", planFile: null, plan: { items: [{ action: "rename", proposedName: "MAC-C02ABC123456" }] } });
  });

  test("saved plan and explicit final confirmation required for apply", async () => {
    responses();
    const directory = await mkdtemp(join(tmpdir(), "namer-wizard-"));
    const file = join(directory, "pilot.plan.json");
    let calls = 0;
    const apply: Apply = async (plan, token, limit) => {
      calls++;
      expect(plan.items[0]?.proposedName).toBe("MAC-C02ABC123456");
      expect(token).toBe("test-token");
      expect(limit).toBe(1);
      return { results: [{ id: plan.items[0]?.id ?? "", status: "submitted", reason: "test" }] };
    };
    try {
      const prompts = answers("all", "macOS", "platform-serial", true, file, "cancel");
      const select = prompts.select;
      prompts.select = (message, options) => {
        if (message.startsWith("Ready to submit")) {
          expect(message).toContain("1 Intune rename action");
          expect(options.map(option => option.value)).toEqual(["cancel", "confirm"]);
        }
        return select(message, options);
      };
      const cancelled = await runWizard({ enableBeta: true, allowIosProfile: false }, prompts, apply, connect);
      expect(cancelled).toMatchObject({ status: "preview", planFile: file });
      expect(calls).toBe(0);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ tenantId: tenant, items: [{ action: "rename" }] });
      const secondFile = join(directory, "approved.plan.json");
      const approved = await runWizard({ enableBeta: true, allowIosProfile: false }, answers("all", "macOS", "platform-serial", true, secondFile, "confirm"), apply, connect);
      expect(approved).toMatchObject({ status: "submitted", planFile: secondFile, results: [{ status: "submitted" }] });
      expect(calls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("wizard reports skipped renames as not submitted", async () => {
    responses();
    const directory = await mkdtemp(join(tmpdir(), "namer-skipped-"));
    const file = join(directory, "pilot.plan.json");
    const apply: Apply = async plan => ({ results: [{ id: plan.items[0]?.id ?? "", status: "skipped", reason: "Assigned Intune username changed since preview." }] });
    const previousExitCode = process.exitCode;
    try {
      const prompts = answers("all", "macOS", "platform-serial", true, file, "confirm");
      let summary = "";
      const note = prompts.note;
      prompts.note = (message, title) => {
        if (title === "Rename results") summary = message;
        note(message, title);
      };
      const result = await runWizard({ enableBeta: true, allowIosProfile: false }, prompts, apply, connect);
      expect(result).toMatchObject({ status: "not-submitted", results: [{ status: "skipped", reason: "Assigned Intune username changed since preview." }] });
      expect(summary).toContain("0 submitted · 1 skipped");
      expect(process.exitCode).toBe(1);
    } finally {
      // `?? 0`, not `undefined`: assigning undefined to process.exitCode is a no-op in Bun,
      // so the whole suite would inherit exit code 1 from this test.
      process.exitCode = previousExitCode ?? 0;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("one-device wizard searches names, detects platform and previews the chosen device", async () => {
    responses();
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const prompts = answers("one", "33333333-3333-3333-3333-333333333333", "exact", "MAC-FINANCE-01", false);
    const select = prompts.select;
    prompts.select = (message, options) => {
      expect(message).not.toMatch(/Platform filter|Connect to Microsoft Graph/);
      return select(message, options);
    };
    const search = prompts.search;
    prompts.search = (message, options) => {
      expect(message).toContain("Search devices");
      expect(options[0]?.label).toContain("OldMac · macOS");
      return search(message, options);
    };
    const result = await runWizard({ enableBeta: false, allowIosProfile: false },
      prompts, apply, connect);
    expect(result).toMatchObject({ status: "preview", plan: { platform: "macOS", deviceId: "33333333-3333-3333-3333-333333333333", items: [{ proposedName: "MAC-FINANCE-01", action: "rename" }] } });
  });
  test("organization displayName supplies an editable company-code suggestion", async () => {
    responses();
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const prompts = answers("all", "macOS", "company-platform-serial", "GLOBALTRADEL", false);
    const text = prompts.text;
    prompts.text = (message, placeholder, initialValue) => {
      if (message.startsWith("Company code")) expect(initialValue).toBe("GLOBALTRADEL");
      return text(message, placeholder, initialValue);
    };
    const result = await runWizard({ enableBeta: false, allowIosProfile: false }, prompts, apply, connect);
    expect(result).toMatchObject({ plan: { company: "GLOBALTRADEL", items: [{ proposedName: "GLOBALTRADEL-MAC-C02ABC123456" }] } });
  });
  test("organization lookup failure still permits a manually entered company code", async () => {
    responsesWithoutOrg();
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const result = await runWizard({ enableBeta: false, allowIosProfile: false },
      answers("all", "macOS", "company-platform-serial", "HQ", false), apply, connect);
    expect(result).toMatchObject({ plan: { company: "HQ", items: [{ proposedName: "HQ-MAC-C02ABC123456" }] } });
  });
  test("custom pattern shows every placeholder and previews assigned username", async () => {
    responses();
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const prompts = answers("one", "33333333-3333-3333-3333-333333333333", "custom", "{platform}-{username}-{serial}", false);
    const note = prompts.note;
    let guide = "";
    prompts.note = (message, title) => {
      if (title === "All custom placeholders") guide = message;
      note(message, title);
    };
    const result = await runWizard({ enableBeta: false, allowIosProfile: false }, prompts, apply, connect);
    for (const token of ["{platform}", "{serial}", "{serial8}", "{company}", "{username}"]) expect(guide).toContain(token);
    expect(result).toMatchObject({ plan: { items: [{ proposedName: "MAC-ALEX-SMITH-C02ABC123456", userPrincipalName: "alex.smith@contoso.com" }] } });
  });
  test("placeholder guide appears before format selection, including when Custom is not selected", async () => {
    responses();
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const prompts = answers("all", "macOS", "platform-serial", false);
    let guide = "";
    const note = prompts.note;
    prompts.note = (message, title) => {
      if (title === "Naming placeholders (custom patterns)") guide = message;
      note(message, title);
    };
    const select = prompts.select;
    prompts.select = (message, options) => {
      if (message.startsWith("Naming format")) expect(guide).toContain("{username}");
      return select(message, options);
    };
    await runWizard({ enableBeta: false, allowIosProfile: false }, prompts, apply, connect);
    for (const token of ["{platform}", "{serial}", "{serial8}", "{company}", "{username}", "{department}"]) expect(guide).toContain(token);
  });
  test("department preset previews Entra department rather than company", async () => {
    responses();
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const result = await runWizard({ enableBeta: false, allowIosProfile: false },
      answers("one", "33333333-3333-3333-3333-333333333333", "department-platform-username-serial", false), apply, connect);
    expect(result).toMatchObject({ plan: { company: "", items: [{ department: "Finance", proposedName: "FI-MAC-ALEX-SMITH-C02ABC123456" }] } });
  });
  test("group wizard saves only Intune-managed direct device members", async () => {
    responses();
    const original = globalThis.fetch;
    const fakeFetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(request).includes("/managedDevices?")) return Response.json({ value: [
        { id: "33333333-3333-3333-3333-333333333333", deviceName: "OldMac", serialNumber: "C02ABC123456", operatingSystem: "macOS", managedDeviceOwnerType: "company", azureADDeviceId: "99999999-9999-9999-9999-999999999999" },
        { id: "55555555-5555-5555-5555-555555555555", deviceName: "OtherMac", serialNumber: "OTHER12345", operatingSystem: "macOS", managedDeviceOwnerType: "company" },
      ] });
      return original(request, init);
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const prompts = answers("group", "66666666-6666-6666-6666-666666666666", "macOS", "platform-serial", false);
    const search = prompts.search;
    prompts.search = (message, options) => {
      expect(message).toContain("security groups");
      expect(options[0]?.label).toBe("Mac Pilot");
      return search(message, options);
    };
    const result = await runWizard({ enableBeta: false, allowIosProfile: false }, prompts, apply, connect);
    expect(result).toMatchObject({ plan: { group: { id: "66666666-6666-6666-6666-666666666666", displayName: "Mac Pilot" },
      items: [{ id: "33333333-3333-3333-3333-333333333333", action: "rename" }] } });
    expect((result as { plan: Plan }).plan.items).toHaveLength(1);
  });
  test("group wizard with no matching managed devices stays preview-only", async () => {
    responses();
    const original = globalThis.fetch;
    const fakeFetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(request).includes("/groups/66666666-6666-6666-6666-666666666666/members"))
        return Response.json({ value: [{ id: "77777777-7777-7777-7777-777777777777", "@odata.type": "#microsoft.graph.user" }] });
      return original(request, init);
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
    const apply: Apply = async () => { throw new Error("Apply must not run."); };
    const result = await runWizard({ enableBeta: true, allowIosProfile: false },
      answers("group", "66666666-6666-6666-6666-666666666666", "all", "platform-serial", false), apply, connect);
    expect(result).toMatchObject({ status: "preview", plan: { items: [] } });
  });
});
