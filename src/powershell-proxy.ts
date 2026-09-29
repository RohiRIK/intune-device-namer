import { fileURLToPath } from "node:url";

type Reply = { ok: boolean; data?: unknown; error?: string };
const script = fileURLToPath(new URL("../GraphProxy.ps1", import.meta.url));
let processHandle: ReturnType<typeof Bun.spawn> | undefined;
const pending: ((line: string) => void)[] = [];
let waiting = Promise.resolve();
let buffer = "";
let decoder = new TextDecoder();

function start(): void {
  if (processHandle) return;
  buffer = "";
  decoder = new TextDecoder();
  const child = Bun.spawn(["pwsh", "-NoProfile", "-File", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  processHandle = child;
  void (async () => {
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          pending.shift()?.(line);
          index = buffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
      for (const resolve of pending.splice(0)) resolve('{"ok":false,"error":"PowerShell Graph proxy exited unexpectedly"}');
      processHandle = undefined;
    }
  })();
}

export async function proxyRequest(request: Record<string, unknown>): Promise<unknown> {
  // Serialise concurrent inventory/directory requests over a single PowerShell session.
  const previous = waiting;
  let release: () => void = () => {};
  waiting = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    start();
    const child = processHandle;
    const stdin = child?.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("PowerShell Graph proxy did not start.");
    const response = new Promise<string>(resolve => pending.push(resolve));
    try {
      stdin.write(new TextEncoder().encode(JSON.stringify(request) + "\n"));
      await stdin.flush();
    } catch (error) {
      pending.pop();
      throw error;
    }
    const line = await response;
    let reply: Reply;
    try { reply = JSON.parse(line) as Reply; }
    catch { throw new Error("PowerShell Graph proxy returned an invalid response."); }
    if (!reply.ok) throw new Error(reply.error ?? "PowerShell Graph proxy failed.");
    return reply.data;
  } finally { release(); }
}

export async function connectPowerShell(): Promise<{ tenantId: string; account: string }> {
  const result = await proxyRequest({ op: "connect" }) as { tenantId?: string; account?: string };
  if (!result.tenantId || !result.account) throw new Error("PowerShell Graph connection has no tenant or account.");
  return { tenantId: result.tenantId, account: result.account };
}

export async function stopPowerShell(): Promise<void> {
  const child = processHandle;
  if (!child) return;
  const stdin = child.stdin;
  if (stdin && typeof stdin !== "number") {
    try { await stdin.end(); } catch { child.kill(); }
  } else child.kill();
  await child.exited;
  processHandle = undefined;
}
