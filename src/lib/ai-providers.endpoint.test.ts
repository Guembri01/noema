import { describe, expect, it } from "vitest";
import {
  classifyAiBaseUrl,
  isLocalAiBaseUrl,
  normalizeBaseUrl,
} from "@/lib/ai-providers";

/**
 * R25.8 — the endpoint half of keyless local models.
 *
 * A base URL is user input that is stored and later called. It may only be an
 * absolute http(s) URL, may not carry a credential, and may use plain http only
 * when it is loopback/private. The same classifier is used by the save action,
 * the test action, the model-list action and the settings form, so a value the
 * UI accepts is exactly a value the server accepts.
 */
describe("classifyAiBaseUrl — accepted endpoints", () => {
  it("accepts a remote https endpoint and reports it as remote", () => {
    const check = classifyAiBaseUrl("https://api.openai.com/v1");

    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("expected an accepted endpoint");
    expect(check.url).toBe("https://api.openai.com/v1");
    expect(check.local).toBe(false);
  });

  it("accepts keyless local endpoints over plain http", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:8000/v1",
      "http://[::1]:1234/v1",
      "http://host.docker.internal:8080/v1",
      "http://192.168.1.20:11434",
      "http://10.0.0.5/v1",
      "http://172.20.0.9/v1",
      "http://ollama.local/v1",
    ]) {
      const check = classifyAiBaseUrl(url);
      expect(check.ok, url).toBe(true);
      if (!check.ok) continue;
      expect(check.local, url).toBe(true);
    }
  });

  it("adds https to a bare host and keeps an explicit scheme", () => {
    expect(normalizeBaseUrl("api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(normalizeBaseUrl("ftp://example.com")).toBe("ftp://example.com");
  });
});

describe("classifyAiBaseUrl — refused endpoints", () => {
  it("refuses every non-http(s) scheme", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/v1",
      "data:text/plain,hello",
      "javascript:alert(1)",
      "ws://example.com/v1",
    ]) {
      expect(classifyAiBaseUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses a credential in the URL user info", () => {
    const check = classifyAiBaseUrl("https://user:secret@example.com/v1");

    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("expected a refusal");
    expect(check.error).toMatch(/username or password/i);
  });

  it("refuses a credential in the query string", () => {
    for (const url of [
      "https://example.com/v1?api_key=sk-live-123",
      "https://example.com/v1?token=abc",
      "https://example.com/v1?password=hunter2",
    ]) {
      const check = classifyAiBaseUrl(url);
      expect(check.ok, url).toBe(false);
      if (check.ok) continue;
      expect(check.error).toMatch(/query string/i);
    }
  });

  it("refuses plain http for a remote host but allows ordinary query data", () => {
    expect(classifyAiBaseUrl("http://example.com/v1").ok).toBe(false);
    expect(classifyAiBaseUrl("https://example.com/v1?region=eu").ok).toBe(true);
  });

  it("refuses empty and unparseable values", () => {
    expect(classifyAiBaseUrl("").ok).toBe(false);
    expect(classifyAiBaseUrl("   ").ok).toBe(false);
    expect(classifyAiBaseUrl("not a url").ok).toBe(false);
  });
});

describe("isLocalAiBaseUrl", () => {
  it("classifies loopback and RFC1918 hosts as local", () => {
    expect(isLocalAiBaseUrl("http://localhost:11434")).toBe(true);
    expect(isLocalAiBaseUrl("https://192.168.0.4/v1")).toBe(true);
  });

  it("never classifies a public host as local", () => {
    expect(isLocalAiBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalAiBaseUrl("http://172.32.0.1/v1")).toBe(false);
    expect(isLocalAiBaseUrl("")).toBe(false);
    expect(isLocalAiBaseUrl(null)).toBe(false);
  });
});
