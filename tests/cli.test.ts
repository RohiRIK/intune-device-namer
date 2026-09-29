import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPlan, revalidationReason } from "../src/cli.ts";
import type { Plan } from "../src/naming.ts";
import { plansDirectory } from "../src/plan-paths.ts";

test("apply --dry-run reads a targeted plan offline and rejects mismatched device IDs", async () => {
  const folder = await mkdtemp(join(tmpdir(), "intune-namer-plan-"));
  const file = join(folder, "single.plan.json");
  const deviceId = "33333333-3333-3333-3333-333333333333";
  const plan = {
    schemaVersion: 1,
    tenantId: "11111111-1111-1111-1111-111111111111",
    platform: "macOS",
    deviceId,
    template: "MAC-FINANCE-01",
    company: "",
    items: [{ id: deviceId, currentName: "OldMac", serialNumber: "C02ABC123456", platform: "macOS", proposedName: "MAC-FINANCE-01", action: "rename", enrollmentProfileName: null }],
  };
  try {
    await writeFile(file, JSON.stringify(plan));
    const run = async (id: string): Promise<{ code: number; stdout: string; stderr: string }> => {
      const child = Bun.spawn(["bun", "run", "src/cli.ts", "apply", "--plan-file", file, "--device-id", id, "--dry-run"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, TENANT_ID: plan.tenantId, CLIENT_ID: "", CLIENT_SECRET: "" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr };
    };
    const preview = await run(deviceId);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ status: "dry-run", plan: { items: [{ proposedName: "MAC-FINANCE-01" }] } });
    const mismatch = await run("44444444-4444-4444-4444-444444444444");
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("does not target only --device-id");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("saved wizard plan with PowerShell auth does not require TENANT_ID or CLIENT_ID for dry-run", async () => {
  const folder = await mkdtemp(join(tmpdir(), "intune-namer-ps-"));
  const file = join(folder, "pilot-4.plan.json");
  try {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS", deviceId: "a32759cb-47f1-42f9-9111-80fef1561e9a", template: "{company}-{platform}-{username}-{serial}", company: "ACME", items: [{ id: "a32759cb-47f1-42f9-9111-80fef1561e9a", platform: "macOS", serialNumber: "C02ABC123456", currentName: "Unknown MacBook Pro", proposedName: "ACME-MAC-ALEX-SMITH-C02ABC123456", action: "rename", enrollmentProfileName: null, userPrincipalName: "alex.smith@contoso.com", userId: "44444444-4444-4444-4444-444444444444" }] }));
    const child = Bun.spawn(["bun", "run", "src/cli.ts", "apply", "--plan-file", file, "--auth", "powershell", "--dry-run"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, TENANT_ID: "", CLIENT_ID: "", CLIENT_SECRET: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "dry-run", plan: { items: [{ proposedName: "ACME-MAC-ALEX-SMITH-C02ABC123456" }] } });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("CLI reads a bare plan filename from plans/ even when launched elsewhere", async () => {
  const filename = `plan-path-${crypto.randomUUID()}.plan.json`;
  const file = join(plansDirectory, filename);
  const plan = { schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS",
    template: "{platform}-{serial}", company: "", items: [] };
  try {
    await writeFile(file, JSON.stringify(plan));
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/cli.ts"), "apply", "--plan-file", filename, "--dry-run"], {
      cwd: tmpdir(), env: { ...process.env, TENANT_ID: "", CLIENT_ID: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "dry-run", plan });
  } finally { await rm(file, { force: true }); }
});

test("apply rechecks assigned user before submitting a username-based rename", async () => {
  const original = globalThis.fetch;
  const deviceId = "33333333-3333-3333-3333-333333333333";
  const plan: Plan = {
    schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS",
    template: "{platform}-{username}-{serial}", company: "", deviceId,
    items: [{ id: deviceId, platform: "macOS", serialNumber: "C02ABC123456", currentName: "OldMac",
      proposedName: "MAC-ALEX-SMITH-C02ABC123456", action: "rename", reason: "Eligible",
      entraName: null, entraDrift: null, enrollmentProfileName: null,
      userPrincipalName: "alex.smith@contoso.com", userId: "44444444-4444-4444-4444-444444444444" }],
  };
  let posts = 0;
  const fakeFetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(request);
    if (init?.method === "POST") { posts++; return new Response(null, { status: 204 }); }
    if (url.includes("/v1.0/devices?")) return Response.json({ value: [] });
    if (url.includes("/managedDevices?")) return Response.json({ value: [] });
    if (url.includes(`/managedDevices/${deviceId}?`)) return Response.json({ id: deviceId, operatingSystem: "macOS", managedDeviceOwnerType: "company", serialNumber: "C02ABC123456", deviceName: "OldMac", userPrincipalName: "someone.else@contoso.com", userId: "55555555-5555-5555-5555-555555555555" });
    throw new Error(`Unexpected request ${url}`);
  };
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
  try {
    const result = await applyPlan(plan, "test-token", 1, false);
    expect(result.results[0]?.status).toBe("skipped");
    expect(posts).toBe(0);
  } finally { globalThis.fetch = original; }
});

test("revalidation identifies what changed and does not require matching Entra display name", () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const item: Plan["items"][number] = {
    id, platform: "macOS", serialNumber: "C02ABC123456", currentName: "OldMac",
    proposedName: "ACME-MAC-ALEX-C02ABC123456", action: "rename", reason: "Eligible",
    entraName: "OldMac", entraDrift: true, enrollmentProfileName: null,
    userPrincipalName: "alex@contoso.com", userId: "44444444-4444-4444-4444-444444444444",
  };
  const plan: Plan = { schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS",
    template: "{company}-{platform}-{username}-{serial}", company: "ACME", deviceId: id, items: [item] };
  const current = { id, deviceName: "OldMac", operatingSystem: "macOS", serialNumber: "C02ABC123456", managedDeviceOwnerType: "company",
    userPrincipalName: "alex@contoso.com", userId: item.userId };
  expect(revalidationReason(item, current, plan, false, [current])).toBeNull();
  expect(revalidationReason(item, { ...current, enrollmentProfileName: "" }, plan, false, [current])).toBeNull();
  expect(revalidationReason(item, { ...current, enrollmentProfileName: "  " }, plan, false, [current])).toBeNull();
  expect(revalidationReason(item, { ...current, deviceName: item.proposedName! }, plan, false, [current])).toContain("Already has");
  expect(revalidationReason(item, { ...current, deviceName: "OtherMac" }, plan, false, [current])).toContain("Device name changed");
  expect(revalidationReason(item, { ...current, userPrincipalName: "sam@contoso.com" }, plan, false, [current])).toContain("username changed");
  expect(revalidationReason(item, { ...current, userId: "55555555-5555-5555-5555-555555555555" }, plan, false, [current])).toContain("user ID changed");
  expect(revalidationReason(item, { ...current, serialNumber: "DIFFERENT123" }, plan, false, [current])).toContain("Serial number changed");
  expect(revalidationReason(item, { ...current, enrollmentProfileName: "Mac enrollment policy" }, plan, false, [current])).toBeNull();
  const reportedMac = { ...current, enrollmentProfileName: "Mac enrollment policy" };
  expect(revalidationReason(item, reportedMac, plan, false, [reportedMac])).toBeNull();
  const iosItem = { ...item, platform: "iOS" as const, enrollmentProfileName: "Old ADE" };
  const iosPlan: Plan = { ...plan, platform: "iOS", items: [iosItem] };
  const iosDevice = { ...current, operatingSystem: "iOS", isSupervised: true, enrollmentProfileName: "New ADE" };
  expect(revalidationReason(iosItem, iosDevice, iosPlan, true, [iosDevice])).toContain("Enrollment profile changed");
  const conflict = { ...current, id: "55555555-5555-5555-5555-555555555555", deviceName: item.proposedName! };
  expect(revalidationReason(item, current, plan, false, [current, conflict])).toContain("Name collision");
});

test("department plan rejects a changed department even when its two-letter prefix is unchanged", () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const device = { id, deviceName: "OldMac", operatingSystem: "macOS", serialNumber: "C02ABC123456",
    managedDeviceOwnerType: "company", userPrincipalName: "alex@contoso.com",
    userId: "44444444-4444-4444-4444-444444444444", department: "Finance" };
  const item: Plan["items"][number] = { id, platform: "macOS", serialNumber: device.serialNumber, currentName: device.deviceName,
    proposedName: "FI-MAC-ALEX-C02ABC123456", action: "rename", reason: "Eligible", entraName: null, entraDrift: null,
    enrollmentProfileName: null, userPrincipalName: device.userPrincipalName, userId: device.userId, department: "Finance" };
  const plan: Plan = { schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS",
    template: "{department}-{platform}-{username}-{serial}", company: "", deviceId: id, items: [item] };
  expect(revalidationReason(item, device, plan, false, [device])).toBeNull();
  expect(revalidationReason(item, { ...device, department: "Financial Services" }, plan, false, [device])).toContain("department changed");
});

test("group apply skips a device removed from its selected group before submitting a POST", async () => {
  const original = globalThis.fetch;
  const id = "33333333-3333-3333-3333-333333333333";
  const device = { id, deviceName: "OldMac", operatingSystem: "macOS", serialNumber: "C02ABC123456",
    managedDeviceOwnerType: "company", azureADDeviceId: "99999999-9999-9999-9999-999999999999" };
  const plan: Plan = { schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS",
    template: "{platform}-{serial}", company: "", group: { id: "66666666-6666-6666-6666-666666666666", displayName: "Mac Pilot" },
    items: [{ id, platform: "macOS", serialNumber: device.serialNumber, currentName: device.deviceName, proposedName: "MAC-C02ABC123456",
      action: "rename", reason: "Eligible", entraName: null, entraDrift: null, enrollmentProfileName: null }] };
  let posts = 0;
  const fakeFetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(request);
    if (init?.method === "POST") { posts++; return new Response(null, { status: 204 }); }
    if (url.includes("/groups/66666666-6666-6666-6666-666666666666/members")) return Response.json({ value: [] });
    if (url.includes("/v1.0/devices?")) return Response.json({ value: [{ id: "77777777-7777-7777-7777-777777777777", deviceId: device.azureADDeviceId, displayName: "OldMac" }] });
    if (url.includes("/managedDevices?")) return Response.json({ value: [device] });
    if (url.includes(`/managedDevices/${id}?`)) return Response.json(device);
    throw new Error(`Unexpected request ${url}`);
  };
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
  try {
    const result = await applyPlan(plan, "test-token", 1, false);
    expect(result.results[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("no longer a direct member") });
    expect(posts).toBe(0);
  } finally { globalThis.fetch = original; }
});

test("group membership read failure stops apply without broadening scope", async () => {
  const original = globalThis.fetch;
  const id = "33333333-3333-3333-3333-333333333333";
  const plan: Plan = { schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS",
    template: "{platform}-{serial}", company: "", group: { id: "66666666-6666-6666-6666-666666666666", displayName: "Mac Pilot" },
    items: [{ id, platform: "macOS", serialNumber: "C02ABC123456", currentName: "OldMac", proposedName: "MAC-C02ABC123456",
      action: "rename", reason: "Eligible", entraName: null, entraDrift: null, enrollmentProfileName: null }] };
  let posts = 0;
  const fakeFetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") { posts++; return new Response(null, { status: 204 }); }
    if (String(request).includes("/groups/")) return new Response("Forbidden", { status: 403 });
    return Response.json({ value: [] });
  };
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
  try {
    await expect(applyPlan(plan, "test-token", 1, false)).rejects.toThrow("403");
    expect(posts).toBe(0);
  } finally { globalThis.fetch = original; }
});

test("group apply submits a still-eligible direct device member", async () => {
  const original = globalThis.fetch;
  const id = "33333333-3333-3333-3333-333333333333";
  const device = { id, deviceName: "OldMac", operatingSystem: "macOS", serialNumber: "C02ABC123456",
    managedDeviceOwnerType: "company", azureADDeviceId: "99999999-9999-9999-9999-999999999999" };
  const plan: Plan = { schemaVersion: 1, tenantId: "11111111-1111-1111-1111-111111111111", platform: "macOS",
    template: "{platform}-{serial}", company: "", group: { id: "66666666-6666-6666-6666-666666666666", displayName: "Mac Pilot" },
    items: [{ id, platform: "macOS", serialNumber: device.serialNumber, currentName: device.deviceName, proposedName: "MAC-C02ABC123456",
      action: "rename", reason: "Eligible", entraName: null, entraDrift: null, enrollmentProfileName: null }] };
  let posts = 0;
  const fakeFetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(request);
    if (init?.method === "POST") { posts++; return new Response(null, { status: 204 }); }
    if (url.includes("/groups/66666666-6666-6666-6666-666666666666/members")) return Response.json({ value: [
      { id: "77777777-7777-7777-7777-777777777777", "@odata.type": "#microsoft.graph.device" },
      { id: "88888888-8888-8888-8888-888888888888", "@odata.type": "#microsoft.graph.user" },
    ] });
    if (url.includes("/v1.0/devices?")) return Response.json({ value: [{ id: "77777777-7777-7777-7777-777777777777", deviceId: device.azureADDeviceId, displayName: "OldMac" }] });
    if (url.includes("/managedDevices?")) return Response.json({ value: [device] });
    if (url.includes(`/managedDevices/${id}?`)) return Response.json(device);
    throw new Error(`Unexpected request ${url}`);
  };
  globalThis.fetch = Object.assign(fakeFetch, { preconnect: () => {} }) as typeof fetch;
  try {
    const result = await applyPlan(plan, "test-token", 1, false);
    expect(result.results[0]?.status).toBe("submitted");
    expect(posts).toBe(1);
  } finally { globalThis.fetch = original; }
});
