import { expect, test } from "bun:test";

import { proxyRequest, stopPowerShell } from "../src/powershell-proxy.ts";

// Shells out to pwsh; the default 5s timeout is flaky when the whole suite runs in parallel.
test("PowerShell proxy rejects unknown commands and out-of-scope Graph URLs without signing in", async () => {
  try {
    await expect(proxyRequest({ op: "unknown" })).rejects.toThrow("Unknown proxy operation");
    await expect(proxyRequest({ op: "request", method: "GET", url: "https://example.org/v1.0/devices" })).rejects.toThrow("not allowed");
    await expect(proxyRequest({ op: "request", method: "POST", url: "https://graph.microsoft.com/beta/users", body: { deviceName: "MAC-1" } })).rejects.toThrow("restricted to the rename action");
  } finally {
    await stopPowerShell();
  }
}, 30_000);
