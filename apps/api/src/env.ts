import { execFileSync } from "node:child_process";

const envCache = new Map<string, string | undefined>();

export function readEnvValue(name: string): string | undefined {
  const processValue = process.env[name];
  if (processValue) return processValue;
  if (envCache.has(name)) return envCache.get(name);
  const systemValue = readWindowsRegistryEnv(name);
  envCache.set(name, systemValue);
  if (systemValue) process.env[name] = systemValue;
  return systemValue;
}

function readWindowsRegistryEnv(name: string): string | undefined {
  if (process.platform !== "win32" || !/^[A-Z_][A-Z0-9_]*$/i.test(name)) return undefined;
  return readRegistryValue("HKCU\\Environment", name) ?? readRegistryValue("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", name);
}

function readRegistryValue(root: string, name: string): string | undefined {
  try {
    const output = execFileSync("reg", ["query", root, "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s+(.+?)\\s*$`, "mi");
    return output.match(pattern)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
