import fs from "fs";

export interface EnvironmentInfo {
  type: string;
  sandboxId: string;
}

export function detectEnvironment(): EnvironmentInfo {
  // 1. Check the Automaton sandbox identifier.
  const sandboxIdEnv = process.env.SANDBOX_ID;
  if (sandboxIdEnv) {
    const sandboxId = sandboxIdEnv.trim();
    if (sandboxId) {
      return { type: "managed-sandbox", sandboxId };
    }
  }

  // 2. Check sandbox config file (new path, falling back to the old
  // legacy-convention path for compatibility with existing images).
  for (const configPath of ["/etc/automaton/sandbox.json", "/etc/backend/sandbox.json"]) {
    try {
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (data.id) {
          const sandboxId = String(data.id).trim();
          if (sandboxId) {
            return { type: "managed-sandbox", sandboxId };
          }
        }
      }
    } catch {}
  }

  // 3. Check Docker
  if (fs.existsSync("/.dockerenv")) {
    return { type: "docker", sandboxId: "" };
  }

  // 4. Fall back to platform
  return { type: process.platform, sandboxId: "" };
}
