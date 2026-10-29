import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const resultsDir = path.join(process.cwd(), "test-results");
const portFile = path.join(resultsDir, "ai-mock.port");
const pidFile = path.join(resultsDir, "ai-mock.pid");

export default async function globalTeardown() {
  const port = existsSync(portFile) ? Number(readFileSync(portFile, "utf8")) : 0;
  const baseUrl = Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}/v1` : null;

  if (baseUrl) {
    const prisma = new PrismaClient();
    try {
      const workspace = await prisma.workspace.findFirst({
        where: { slug: "demo-workspace" },
        select: { id: true },
      });
      if (workspace) {
        const current = await prisma.aiProviderConfig.findUnique({
          where: { workspaceId: workspace.id },
          select: { baseUrl: true },
        });
        if (current?.baseUrl === baseUrl) {
          await prisma.aiProviderConfig.delete({ where: { workspaceId: workspace.id } });
        }
      }
    } finally {
      await prisma.$disconnect();
    }
  }

  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    rmSync(pidFile, { force: true });
    if (Number.isInteger(pid) && pid > 0) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch {
        // already stopped
      }
    }
  }
  rmSync(portFile, { force: true });
}
