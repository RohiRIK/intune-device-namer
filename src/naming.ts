export type Platform = "macOS" | "Windows" | "iOS" | "Android";
export type Device = {
  id: string;
  deviceName: string;
  serialNumber: string;
  operatingSystem: string;
  managedDeviceOwnerType: string;
  deviceEnrollmentType?: string;
  enrollmentProfileName?: string;
  azureADDeviceId?: string;
  isSupervised?: boolean;
  managementAgent?: string;
  joinType?: string;
  userPrincipalName?: string | null;
  userId?: string | null;
  department?: string | null;
};
export type EntraName = { displayName: string; id: string };
export type PlanItem = {
  id: string;
  platform: Platform | "unsupported";
  serialNumber: string;
  currentName: string;
  proposedName: string | null;
  action: "rename" | "unchanged" | "skip";
  reason: string;
  entraName: string | null;
  entraDrift: boolean | null;
  enrollmentProfileName: string | null;
  userPrincipalName?: string | null;
  userId?: string | null;
  department?: string | null;
};
export type Plan = {
  schemaVersion: 1;
  tenantId: string;
  template: string;
  platform: Platform | "all";
  company: string;
  deviceId?: string;
  group?: { id: string; displayName: string };
  items: PlanItem[];
};

export const TEMPLATES = {
  "platform-serial": "{platform}-{serial}",
  "company-platform-serial": "{company}-{platform}-{serial}",
  "compact-serial": "{platform}-{serial8}",
  "platform-username-serial": "{platform}-{username}-{serial}",
  "company-platform-username-serial": "{company}-{platform}-{username}-{serial}",
  "department-platform-username-serial": "{department}-{platform}-{username}-{serial}",
} as const;
const CODES: Record<Platform, string> = { macOS: "MAC", Windows: "WIN", iOS: "IOS", Android: "AND" };

export function companySuggestion(displayName: string): string {
  return displayName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function enrollmentProfile(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export function platformOf(os: string): Platform | "unsupported" {
  const lower = os.toLowerCase();
  if (lower === "macos" || lower === "mac os x") return "macOS";
  if (lower === "windows") return "Windows";
  if (lower === "ios" || lower === "ipados") return "iOS";
  if (lower === "android") return "Android";
  return "unsupported";
}

export function templateOf(value: string): string {
  const template = TEMPLATES[value as keyof typeof TEMPLATES] ?? value;
  if (!template || /[{}]/.test(template.replace(/\{(?:platform|serial|serial8|company|username|department)\}/g, "")))
    throw new Error("Invalid template tokens; use {platform}, {serial}, {serial8}, {company}, {username}, {department}.");
  return template;
}

export function departmentCode(value: string | null | undefined): string {
  const letters = value?.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "") ?? "";
  if (letters.length < 2) throw new Error("Assigned user's Entra department has fewer than two usable letters for {department}.");
  return letters.slice(0, 2);
}

export function usernameOf(upn: string | null | undefined): string {
  const localPart = upn?.trim().split("@");
  if (localPart?.length !== 2 || !localPart[0] || !localPart[1]) throw new Error("Intune userPrincipalName is missing or invalid for {username}.");
  const username = localPart[0].normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!username || !/[A-Z]/.test(username)) throw new Error("Intune username has no usable letters for {username}.");
  return username;
}

export function render(template: string, platform: Platform, serial: string, company: string, userPrincipalName?: string | null, department?: string | null): string {
  templateOf(template);
  const cleanSerial = (serial ?? "").trim().toUpperCase();
  if (/\{serial(?:8)?\}/.test(template) && !/^[A-Z0-9-]+$/.test(cleanSerial)) throw new Error("Serial unavailable or contains unsupported characters.");
  if (template.includes("{serial8}") && cleanSerial.length < 8) throw new Error("Serial too short for {serial8}.");
  if (template.includes("{company}") && !company) throw new Error("--company is required for this template.");
  if (company && !/^[A-Za-z0-9]{1,12}$/.test(company)) throw new Error("Company code must be 1–12 ASCII letters or digits.");
  const username = template.includes("{username}") ? usernameOf(userPrincipalName) : "";
  const dept = template.includes("{department}") ? departmentCode(department) : "";
  const name = template.replace(/\{(platform|serial8|serial|company|username|department)\}/g, (_, token: string) => {
    if (token === "platform") return CODES[platform];
    if (token === "serial") return cleanSerial;
    if (token === "serial8") return cleanSerial.slice(-8);
    if (token === "username") return username;
    if (token === "department") return dept;
    return company.toUpperCase();
  }).toUpperCase();
  if (!/^[A-Z0-9-]{1,63}$/.test(name) || !/[A-Z]/.test(name) || name.startsWith("-") || name.endsWith("-")) {
    throw new Error("Name must be 1–63 letters, numbers or hyphens, include a letter, and not start/end with a hyphen.");
  }
  return name;
}

export function eligibility(device: Device, platform: Platform, allowIosProfile: boolean): string | null {
  if (device.managedDeviceOwnerType.toLowerCase() !== "company") return "Only corporate-owned devices can use this rename action.";
  if (platform === "iOS") {
    if (!device.isSupervised) return "iOS/iPadOS device is not supervised.";
    if (enrollmentProfile(device.enrollmentProfileName) && !allowIosProfile) return "iOS enrollment profile may restore its naming template at next check-in.";
  }
  if (platform === "Windows" && device.joinType?.toLowerCase() === "serverad") return "Hybrid-joined Windows device; rename via domain management.";
  if (platform === "Windows" && !device.joinType) return "Cannot confirm Windows join type from Entra inventory; hybrid join is unsupported.";
  if (platform === "Windows" && device.deviceEnrollmentType?.toLowerCase().includes("co-management")) return "Co-managed Windows device requires separate review.";
  if (platform === "Android") {
    const mode = (device.deviceEnrollmentType ?? "").toLowerCase();
    if (!/(fullymanaged|dedicated|corporateowned|cope)/.test(mode)) return "Android Enterprise ownership mode cannot be confirmed as supported.";
  }
  return null;
}

export function makePlan(devices: Device[], entra: Map<string, EntraName>, config: {
  tenantId: string; template: string; platform: Platform | "all"; company: string; allowIosProfile: boolean; deviceId?: string;
  group?: { id: string; displayName: string }; groupMemberIds?: ReadonlySet<string>;
}): Plan {
  const template = templateOf(config.template);
  if (config.deviceId && config.group) throw new Error("Choose either one device or a group, not both.");
  if (config.group && !config.groupMemberIds) throw new Error("Group membership was not loaded; cannot create a group plan.");
  if (config.deviceId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(config.deviceId)) throw new Error("deviceId must be an Intune managed-device GUID.");
  const target = config.deviceId ? devices.find(d => d.id.toLowerCase() === config.deviceId?.toLowerCase()) : undefined;
  if (config.deviceId && !target) throw new Error(`Managed device ${config.deviceId} was not found in Intune inventory.`);
  const detectedPlatform = target ? platformOf(target.operatingSystem) : undefined;
  if (detectedPlatform === "unsupported") throw new Error(`Unsupported operating system for managed device ${config.deviceId}: ${target?.operatingSystem}.`);
  const selectedPlatform = detectedPlatform ?? config.platform;
  const memberDeviceIds = config.group ? new Set(devices.filter(device => device.azureADDeviceId &&
    config.groupMemberIds?.has(entra.get(device.azureADDeviceId.toLowerCase())?.id.toLowerCase() ?? ""))
    .map(device => device.id.toLowerCase())) : null;
  const items: PlanItem[] = devices.filter(d =>
    (selectedPlatform === "all" || platformOf(d.operatingSystem) === selectedPlatform) &&
    (!memberDeviceIds || memberDeviceIds.has(d.id.toLowerCase()))
  ).map(d => {
    const platform = platformOf(d.operatingSystem);
    const matched = d.azureADDeviceId ? entra.get(d.azureADDeviceId.toLowerCase()) : undefined;
    const base = { id: d.id, platform, serialNumber: d.serialNumber ?? "", currentName: d.deviceName,
      entraName: matched?.displayName ?? null, enrollmentProfileName: enrollmentProfile(d.enrollmentProfileName),
      ...(template.includes("{username}") || template.includes("{department}") ? { userPrincipalName: d.userPrincipalName ?? null, userId: d.userId ?? null } : {}),
      ...(template.includes("{department}") ? { department: d.department ?? null } : {}) };
    let proposedName: string | null = null;
    let reason = platform === "unsupported" ? "Unsupported platform." : eligibility(d, platform, config.allowIosProfile);
    if (!reason && platform !== "unsupported") {
      try {
        if (template.includes("{department}") && !d.userId) throw new Error("No assigned Intune user ID for {department}.");
        proposedName = render(template, platform, d.serialNumber ?? "", config.company, d.userPrincipalName, d.department);
      }
      catch (error) { reason = error instanceof Error ? error.message : String(error); }
    }
    return { ...base, proposedName, action: reason ? "skip" as const : proposedName === d.deviceName ? "unchanged" as const : "rename" as const,
      reason: reason ?? (proposedName === d.deviceName ? "Already named." : "Eligible for Intune rename."),
      entraDrift: matched && proposedName ? matched.displayName !== proposedName : null };
  });
  const names = new Map<string, PlanItem[]>();
  for (const item of items) if (item.proposedName) names.set(item.proposedName.toLowerCase(), [...(names.get(item.proposedName.toLowerCase()) ?? []), item]);
  for (const matches of names.values()) if (matches.length > 1) for (const item of matches) {
    item.action = "skip"; item.reason = "Name collision in selected inventory.";
  }
  for (const item of items) if (item.action === "rename" && item.proposedName && devices.some(d => d.id !== item.id && d.deviceName.toLowerCase() === item.proposedName?.toLowerCase())) {
    item.action = "skip"; item.reason = "Proposed name already belongs to another Intune device.";
  }
  const selected = config.deviceId ? items.filter(i => i.id.toLowerCase() === config.deviceId?.toLowerCase()) : items;
  return { schemaVersion: 1, tenantId: config.tenantId, template, platform: selectedPlatform, company: config.company,
    ...(config.deviceId ? { deviceId: config.deviceId } : {}), ...(config.group ? { group: config.group } : {}), items: selected };
}
