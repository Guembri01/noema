import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const resultsDir = path.join(process.cwd(), "test-results");
const portFile = path.join(resultsDir, "ai-mock.port");
const pidFile = path.join(resultsDir, "ai-mock.pid");

async function waitForPort() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8"));
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("E2E AI mock did not report a port");
}

async function waitForHealth(port: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("E2E AI mock did not become healthy");
}

/**
 * The chat test exercises the real stream/persistence route, which needs a
 * provider. Boot a deterministic loopback provider on an ephemeral port and
 * point the demo workspace at it for the duration of the run. Global teardown
 * removes the row and stops the process, so a normal local checkout keeps
 * "AI not configured". An ephemeral port keeps back-to-back isolated runs from
 * racing a previous mock that is still shutting down.
 */
export default async function globalSetup() {
  mkdirSync(resultsDir, { recursive: true });
  rmSync(portFile, { force: true });
  rmSync(pidFile, { force: true });

  const child = spawn(process.execPath, [path.join(process.cwd(), "e2e", "ai-mock-server.mjs")], {
    env: {
      ...process.env,
      E2E_AI_MOCK_PORT: "0",
      E2E_AI_MOCK_PORT_FILE: portFile,
    },
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid ?? ""));

  const port = await waitForPort();
  await waitForHealth(port);
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const prisma = new PrismaClient();
  try {
    const workspace = await prisma.workspace.findFirst({
      where: { slug: "demo-workspace" },
      select: { id: true },
    });
    if (!workspace) throw new Error("demo-workspace is missing; run npm run db:seed");
    await prisma.aiProviderConfig.upsert({
      where: { workspaceId: workspace.id },
      create: {
        workspaceId: workspace.id,
        provider: "custom",
        baseUrl,
        model: "mock-model",
        apiKeyEncrypted: null,
        enabled: true,
      },
      update: {
        provider: "custom",
        baseUrl,
        model: "mock-model",
        apiKeyEncrypted: null,
        enabled: true,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
