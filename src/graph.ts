import type { Device, EntraName } from "./naming.ts";

import { proxyRequest } from "./powershell-proxy.ts";

type Token = { access_token?: string; error?: string; error_description?: string; interval?: number; expires_in?: number; device_code?: string; user_code?: string; verification_uri?: string };
type Page<T> = { value: T[]; "@odata.nextLink"?: string };
const ORIGIN = "https://graph.microsoft.com";
export const POWERSHELL_TOKEN = "powershell-graph-session";
const guid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function requireGuid(value: string, field: string): string {
  if (!guid.test(value)) throw new Error(`${field} must be a GUID.`);
  return value;
}

async function tokenPost(tenant: string, path: string, params: URLSearchParams): Promise<Token> {
  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/${path}`, { method: "POST", body: params });
  const result: unknown = await response.json();
  if (!result || typeof result !== "object") throw new Error("Invalid token response.");
  return result as Token;
}

export async function authenticate(tenant: string, client: string, mode: "app" | "device", write: boolean): Promise<string> {
  requireGuid(tenant, "TENANT_ID"); requireGuid(client, "CLIENT_ID");
  if (mode === "app") {
    const secret = process.env.CLIENT_SECRET;
    if (!secret) throw new Error("CLIENT_SECRET is required for --auth app.");
    const result = await tokenPost(tenant, "token", new URLSearchParams({ client_id: client, client_secret: secret, scope: `${ORIGIN}/.default`, grant_type: "client_credentials" }));
    if (!result.access_token) throw new Error(`App sign-in failed: ${result.error_description ?? result.error ?? "unknown error"}`);
    return result.access_token;
  }
  const scopes = ["DeviceManagementManagedDevices.Read.All", "Device.Read.All", "User.Read", "User.Read.All", "Group.Read.All"];
  if (write) scopes.push("DeviceManagementManagedDevices.PrivilegedOperations.All");
  const challenge = await tokenPost(tenant, "devicecode", new URLSearchParams({ client_id: client, scope: scopes.join(" ") }));
  if (!challenge.device_code || !challenge.verification_uri || !challenge.user_code) throw new Error(`Device sign-in failed: ${challenge.error_description ?? challenge.error}`);
  console.error(`Open ${challenge.verification_uri} and enter code ${challenge.user_code}`);
  const expires = Date.now() + (challenge.expires_in ?? 900) * 1000;
  let interval = challenge.interval ?? 5;
  while (Date.now() < expires) {
    await Bun.sleep(interval * 1000);
    const result = await tokenPost(tenant, "token", new URLSearchParams({ client_id: client, device_code: challenge.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }));
    if (result.access_token) return result.access_token;
    if (result.error === "slow_down") { interval += 5; continue; }
    if (result.error !== "authorization_pending") throw new Error(`Device sign-in failed: ${result.error_description ?? result.error}`);
  }
  throw new Error("Device sign-in timed out.");
}

export async function graph<T>(token: string, url: string, method = "GET", body?: unknown): Promise<T> {
  const parsed = new URL(url, ORIGIN);
  if (parsed.origin !== ORIGIN || !/^\/(v1\.0|beta)\//.test(parsed.pathname)) throw new Error("Graph URL is outside the permitted host/version.");
  if (token === POWERSHELL_TOKEN) return await proxyRequest({ op: "request", url: parsed.href, method, body }) as T;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(parsed, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (method === "GET" && (response.status === 429 || response.status >= 500) && attempt < 4) {
      const retry = Number(response.headers.get("Retry-After"));
      await Bun.sleep((Number.isFinite(retry) && retry > 0 ? Math.min(retry, 30) : 2 ** attempt) * 1000);
      continue;
    }
    if (!response.ok) throw new Error(`Graph ${method} ${parsed.pathname}: HTTP ${response.status} ${response.statusText} (${(await response.text()).slice(0, 250)})`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  throw new Error("Graph retry limit exceeded.");
}

export async function pages<T>(token: string, url: string): Promise<T[]> {
  const result: T[] = [];
  let next: string | undefined = url;
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next)) throw new Error("Graph pagination loop detected.");
    visited.add(next);
    const page: Page<T> = await graph<Page<T>>(token, next);
    if (!page || !Array.isArray(page.value)) throw new Error("Graph returned an invalid page.");
    result.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return result;
}

export async function inventory(token: string): Promise<Device[]> {
  const url = `${ORIGIN}/v1.0/deviceManagement/managedDevices?$select=id,deviceName,serialNumber,operatingSystem,managedDeviceOwnerType,deviceEnrollmentType,enrollmentProfileName,azureADDeviceId,isSupervised,managementAgent,userPrincipalName,userId&$top=100`;
  const devices = await pages<Device>(token, url);
  // Directory trustType is fetched via Entra inventory below; no assumption from Intune enrollment mode.
  return devices;
}

export async function directory(token: string): Promise<Map<string, EntraName & { trustType?: string }>> {
  const devices = await pages<{ id: string; deviceId: string; displayName: string; trustType?: string }>(token,
    `${ORIGIN}/v1.0/devices?$select=id,deviceId,displayName,trustType&$top=100`);
  return new Map(devices.filter(d => d.deviceId).map(d => [d.deviceId.toLowerCase(), { id: d.id, displayName: d.displayName, trustType: d.trustType }]));
}

export type DeviceGroup = { id: string; displayName: string; securityEnabled: boolean };

export async function groups(token: string): Promise<DeviceGroup[]> {
  const found = await pages<DeviceGroup>(token, `${ORIGIN}/v1.0/groups?$select=id,displayName,securityEnabled&$top=100`);
  return found.filter(group => group.securityEnabled && group.id && group.displayName);
}

export async function groupDeviceMembers(token: string, groupId: string): Promise<Set<string>> {
  requireGuid(groupId, "group ID");
  // Direct membership: nested-group and user members are deliberately not expanded.
  const found = await pages<{ id?: string; "@odata.type"?: string }>(token,
    `${ORIGIN}/v1.0/groups/${groupId}/members?$top=100`);
  if (found.some(member => !member.id || !member["@odata.type"])) throw new Error("Group membership response is incomplete; no devices will be renamed.");
  return new Set(found.filter(member => member["@odata.type"] === "#microsoft.graph.device" && member.id)
    .map(member => member.id!.toLowerCase()));
}

export async function organizationName(token: string): Promise<string | null> {
  const response = await graph<Page<{ displayName?: string }>>(token, `${ORIGIN}/v1.0/organization?$select=displayName`);
  return response.value[0]?.displayName?.trim() || null;
}

export async function getDevice(token: string, id: string): Promise<Device> {
  requireGuid(id, "device id");
  return await graph<Device>(token, `${ORIGIN}/v1.0/deviceManagement/managedDevices/${id}?$select=id,deviceName,serialNumber,operatingSystem,managedDeviceOwnerType,deviceEnrollmentType,enrollmentProfileName,azureADDeviceId,isSupervised,managementAgent,userPrincipalName,userId`);
}

export async function getUserDepartment(token: string, userId: string): Promise<string | null> {
  requireGuid(userId, "assigned user ID");
  const user = await graph<{ department?: string | null }>(token, `${ORIGIN}/v1.0/users/${userId}?$select=department`);
  return user.department?.trim() || null;
}

export async function enrichDepartments(token: string, devices: Device[], template: string): Promise<void> {
  if (!template.includes("{department}")) return;
  // Resolve each assigned user once; Graph /users/{id} requires an explicit $select
  // for department, which is absent from the managed-device inventory response.
  const users = [...new Set(devices.map(d => d.userId).filter((id): id is string => Boolean(id)))];
  const values = await Promise.all(users.map(async userId => [userId, await getUserDepartment(token, userId)] as const));
  const departments = new Map(values);
  for (const device of devices) device.department = device.userId ? departments.get(device.userId) ?? null : null;
}

export async function setName(token: string, id: string, name: string): Promise<void> {
  requireGuid(id, "device id");
  await graph<void>(token, `${ORIGIN}/beta/deviceManagement/managedDevices/${id}/setDeviceName`, "POST", { deviceName: name });
}
