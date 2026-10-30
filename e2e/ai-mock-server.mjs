import http from "node:http";
import { writeFileSync } from "node:fs";

/**
 * Deterministic OpenAI-compatible provider for the E2E suite.
 *
 * The chat surface is part of the product contract, but a local checkout has
 * no provider key and must not depend on the public internet. This tiny server
 * speaks the subset the app's streaming transport uses, so the real route,
 * grounding and persistence code still runs end to end.
 */
const port = Number(process.env.E2E_AI_MOCK_PORT ?? 0);
const portFile = process.env.E2E_AI_MOCK_PORT_FILE;

const ANSWER = "Here are the projects and their milestone progress from this workspace.";

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock-model", object: "model", owned_by: "noema-e2e" }],
      }),
    );
    return;
  }

  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let body = "";
  for await (const chunk of request) body += chunk;
  const streaming = body.includes('"stream":true') || body.includes('"stream": true');
  const usage = { prompt_tokens: 32, completion_tokens: 16 };

  if (!streaming) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: ANSWER } }],
        usage,
      }),
    );
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const word of ANSWER.split(" ")) {
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`,
    );
  }
  response.write(`data: ${JSON.stringify({ usage })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (portFile && address && typeof address === "object") {
    writeFileSync(portFile, String(address.port));
  }
});
