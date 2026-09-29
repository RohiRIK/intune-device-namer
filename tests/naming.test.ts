import { describe, expect, test } from "bun:test";

import { companySuggestion, departmentCode, eligibility, makePlan, render, templateOf, usernameOf } from "../src/naming.ts";
import type { Device } from "../src/naming.ts";

const mac: Device = { id: "11111111-1111-1111-1111-111111111111", deviceName: "MacBook", serialNumber: "C02ABC123456", operatingSystem: "macOS", managedDeviceOwnerType: "company" };
const config = { tenantId: "22222222-2222-2222-2222-222222222222", template: "platform-serial", platform: "all" as const, company: "", allowIosProfile: false };

describe("templates and safety", () => {
  test("expands standard names consistently", () => {
    expect(render(templateOf("company-platform-serial"), "macOS", mac.serialNumber, "ABC")).toBe("ABC-MAC-C02ABC123456");
    expect(render(templateOf("compact-serial"), "macOS", mac.serialNumber, "")).toBe("MAC-BC123456");
  });
  test("rejects invalid input and unsupported tokens", () => {
    expect(() => templateOf("{user}-{serial}")).toThrow();
    expect(() => render("{platform}-{serial}", "macOS", "", "")).toThrow();
    expect(() => render("{company}-{serial}", "macOS", mac.serialNumber, "")).toThrow();
    expect(() => render("X".repeat(64), "macOS", mac.serialNumber, "")).toThrow();
  });
  test("renders username from Intune UPN and normalizes invalid hostname characters", () => {
    expect(usernameOf("Alex.Smith+IT@contoso.com")).toBe("ALEX-SMITH-IT");
    expect(render("{company}-{platform}-{username}-{serial}", "macOS", mac.serialNumber, "ACME", "alex.smith@contoso.com"))
      .toBe("ACME-MAC-ALEX-SMITH-C02ABC123456");
    expect(() => render("{platform}-{username}-{serial}", "macOS", mac.serialNumber, "")).toThrow("userPrincipalName");
  });
  test("department preset uses two letters without a company code", () => {
    expect(departmentCode(" Fïnance & Operations ")).toBe("FI");
    expect(render(templateOf("department-platform-username-serial"), "macOS", mac.serialNumber, "", "alex.smith@contoso.com", "Finance"))
      .toBe("FI-MAC-ALEX-SMITH-C02ABC123456");
    expect(() => departmentCode("7 Z")).toThrow("fewer than two");
    expect(() => render("{department}-{platform}-{username}-{serial}", "macOS", mac.serialNumber, "", "alex@contoso.com", null)).toThrow("department");
  });
});

describe("platform and existing device safeguards", () => {
  test("macOS corporate device can be named without ADE", () => {
    expect(makePlan([mac], new Map(), config).items[0]?.action).toBe("rename");
    expect(makePlan([{ ...mac, enrollmentProfileName: "" }], new Map(), config).items[0]?.enrollmentProfileName).toBeNull();
  });
  test("unsupported enrollment, iOS profile and Windows hybrid join are skipped", () => {
    expect(eligibility({ ...mac, managedDeviceOwnerType: "personal" }, "macOS", false)).toContain("corporate");
    expect(eligibility({ ...mac, enrollmentProfileName: "ADE", isSupervised: true }, "iOS", false)).toContain("profile");
    expect(eligibility({ ...mac, enrollmentProfileName: "", isSupervised: true }, "iOS", false)).toBeNull();
    expect(eligibility({ ...mac, joinType: "ServerAd" }, "Windows", false)).toContain("Hybrid");
    expect(eligibility({ ...mac }, "Windows", false)).toContain("Cannot confirm");
    expect(eligibility({ ...mac }, "Android", false)).toContain("cannot be confirmed");
  });
  test("rejects duplicate serial-derived names and names already in inventory", () => {
    const duplicate = { ...mac, id: "33333333-3333-3333-3333-333333333333" };
    expect(makePlan([mac, duplicate], new Map(), config).items.map(i => i.action)).toEqual(["skip", "skip"]);
    const existing = { ...duplicate, serialNumber: "OTHER12345", deviceName: "MAC-C02ABC123456" };
    expect(makePlan([mac, existing], new Map(), config).items[0]?.action).toBe("skip");
  });
  test("reports Entra drift without adding an Entra write action", () => {
    const entry = makePlan([{ ...mac, azureADDeviceId: "id" }], new Map([["id", { id: "graph-id", displayName: "OldName" }]]), config).items[0];
    expect(entry?.entraDrift).toBe(true);
    expect(entry?.action).toBe("rename");
  });
  test("single-device plans retain collision checks against the entire inventory", () => {
    const other = { ...mac, id: "33333333-3333-3333-3333-333333333333", serialNumber: "DIFFERENT123", deviceName: "MAC-C02ABC123456" };
    const plan = makePlan([mac, other], new Map(), { ...config, deviceId: mac.id });
    expect(plan.items).toHaveLength(1);
    expect(plan.deviceId).toBe(mac.id);
    expect(plan.items[0]?.action).toBe("skip");
    expect(() => makePlan([mac, other], new Map(), { ...config, deviceId: "44444444-4444-4444-4444-444444444444" })).toThrow("not found");
  });
  test("exact names work for a targeted plan", () => {
    const plan = makePlan([mac], new Map(), { ...config, template: "MAC-FINANCE-01", deviceId: mac.id });
    expect(plan.items[0]?.proposedName).toBe("MAC-FINANCE-01");
    expect(plan.platform).toBe("macOS");
    expect(makePlan([mac], new Map(), { ...config, platform: "Windows", deviceId: mac.id }).platform).toBe("macOS");
    expect(() => makePlan([{ ...mac, operatingSystem: "Linux" }], new Map(), { ...config, deviceId: mac.id })).toThrow("Unsupported operating system");
  });
  test("suggests a short ASCII company code from the organization display name", () => {
    expect(companySuggestion("Global Tradé Ltd")).toBe("GLOBALTRADEL");
    expect(companySuggestion("株式会社")).toBe("");
  });
  test("username-based plan skips devices without a user, snapshots user, and detects collisions", () => {
    const template = "platform-username-serial";
    const missing = makePlan([mac], new Map(), { ...config, template }).items[0];
    expect(missing?.action).toBe("skip");
    expect(missing?.reason).toContain("userPrincipalName");
    const assigned = { ...mac, userPrincipalName: "alex.smith@contoso.com", userId: "44444444-4444-4444-4444-444444444444" };
    const planned = makePlan([assigned], new Map(), { ...config, template }).items[0];
    expect(planned).toMatchObject({ action: "rename", proposedName: "MAC-ALEX-SMITH-C02ABC123456", userPrincipalName: assigned.userPrincipalName, userId: assigned.userId });
    const duplicate = { ...assigned, id: "55555555-5555-5555-5555-555555555555", userPrincipalName: "alex_smith@contoso.com" };
    expect(makePlan([assigned, duplicate], new Map(), { ...config, template }).items.map(i => i.action)).toEqual(["skip", "skip"]);
  });
  test("department plan skips missing department or user and snapshots full department", () => {
    const template = "department-platform-username-serial";
    const assigned = { ...mac, userPrincipalName: "alex@contoso.com", userId: "44444444-4444-4444-4444-444444444444" };
    expect(makePlan([assigned], new Map(), { ...config, template }).items[0]).toMatchObject({ action: "skip", department: null });
    expect(makePlan([{ ...assigned, department: "Finance", userId: null }], new Map(), { ...config, template }).items[0]?.reason).toContain("user ID");
    expect(makePlan([{ ...assigned, department: "Finance" }], new Map(), { ...config, template }).items[0]).toMatchObject({
      action: "rename", department: "Finance", proposedName: "FI-MAC-ALEX-C02ABC123456",
    });
  });
  test("group plan includes only direct Entra device members, not user IDs or unmatched devices", () => {
    const group = { id: "66666666-6666-6666-6666-666666666666", displayName: "Mac Pilot" };
    const first = { ...mac, azureADDeviceId: "aaaa0000-0000-0000-0000-000000000001" };
    const second = { ...mac, id: "33333333-3333-3333-3333-333333333333", serialNumber: "OTHER12345", azureADDeviceId: "aaaa0000-0000-0000-0000-000000000002" };
    const unmatched = { ...mac, id: "55555555-5555-5555-5555-555555555555", serialNumber: "MORE12345" };
    const entra = new Map([[first.azureADDeviceId, { id: "77777777-7777-7777-7777-777777777777", displayName: "First" }],
      [second.azureADDeviceId, { id: "88888888-8888-8888-8888-888888888888", displayName: "Second" }]]);
    const plan = makePlan([first, second, unmatched], entra, { ...config, group, groupMemberIds: new Set(["77777777-7777-7777-7777-777777777777"]) });
    expect(plan.group).toEqual(group);
    expect(plan.items.map(item => item.id)).toEqual([first.id]);
    expect(() => makePlan([first], entra, { ...config, group })).toThrow("membership was not loaded");
  });
});
