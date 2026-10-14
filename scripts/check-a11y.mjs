// Lighthweight WCAG structural audit for the rendered app shell.
// Usage: node --env-file=.env scripts/check-a11y.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const page = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, parentId: null },
});
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

const results = [];
const check = (label, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const strip = (value) => value.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, "").trim();

function audit(name, html, { singleH1 = true } = {}) {
  check(`${name}: declares a lang and dir`, /<html[^>]+lang="[a-z-]+"/i.test(html) && /<html[^>]+dir="(ltr|rtl)"/i.test(html));
  check(`${name}: has a skip link to #main`, /<a[^>]+href="#main"/i.test(html));
  check(`${name}: exposes a main landmark`, /<main[\s>]/i.test(html));

  const h1s = html.match(/<h1[\s>]/gi) ?? [];
  check(
    singleH1 ? `${name}: exactly one h1` : `${name}: has at least one h1`,
    singleH1 ? h1s.length === 1 : h1s.length >= 1,
  );

  const navs = html.match(/<nav[^>]*>/gi) ?? [];
  check(`${name}: every nav is labelled`, navs.every((tag) => /aria-label=|aria-labelledby=/i.test(tag)));

  // Icon-only buttons must carry an accessible name.
  const buttons = html.match(/<button\b[\s\S]*?<\/button>/gi) ?? [];
  const unlabelled = buttons.filter((button) => {
    const open = button.slice(0, button.indexOf(">") + 1);
    if (/aria-label=|aria-labelledby=|title=/i.test(open)) return false;
    return strip(button) === "";
  });
  check(`${name}: icon-only buttons are labelled (${unlabelled.length} offenders)`, unlabelled.length === 0);
  if (unlabelled.length > 0) {
    for (const snippet of unlabelled.slice(0, 4)) console.log(`      ${snippet.slice(0, 160)}`);
  }

  // Form controls need a label, aria-label or aria-labelledby.
  const controls = (html.match(/<(input|select|textarea)\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      !/type="(hidden|submit|button|image|reset)"/i.test(tag) &&
      !/class="[^"]*\bhidden\b/i.test(tag) &&
      !/display:\s*none/i.test(tag) &&
      !/aria-hidden="true"/i.test(tag),
  );
  const ids = new Set([...html.matchAll(/<label[^>]+for="([^"]+)"/gi)].map((m) => m[1]));
  const labelRanges = [...html.matchAll(/<label\b[\s\S]*?<\/label>/gi)].map((m) => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);
  const insideLabel = (index) =>
    labelRanges.some(([start, end]) => index >= start && index < end);
  const unlabelledControls = controls.filter((tag) => {
    if (/aria-label=|aria-labelledby=|title=/.test(tag)) return false;
    const id = /id="([^"]+)"/.exec(tag)?.[1];
    if (id && ids.has(id)) return false;
    return !insideLabel(html.indexOf(tag));
  });
  check(`${name}: form controls are labelled (${unlabelledControls.length} offenders)`, unlabelledControls.length === 0);
  if (unlabelledControls.length > 0) {
    for (const snippet of unlabelledControls.slice(0, 6)) console.log(`      ${snippet.slice(0, 200)}`);
  }

  // Images need alt text.
  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  check(`${name}: images have alt text`, images.every((tag) => /\balt=/.test(tag)));
}

const login = await fetch(`${base}/login`).then((r) => r.text());
audit("/login", login);

const signup = await fetch(`${base}/signup`).then((r) => r.text());
audit("/signup", signup);

const workspaceHtml = await fetch(`${base}/w/${workspace.slug}/${page.id}`, {
  headers: { cookie: `noema_session=${session}` },
}).then((r) => r.text());
audit(`/w/${workspace.slug}/[page]`, workspaceHtml, { singleH1: false });

const settingsHtml = await fetch(`${base}/w/${workspace.slug}/settings`, {
  headers: { cookie: `noema_session=${session}` },
}).then((r) => r.text());
audit(`/w/${workspace.slug}/settings`, settingsHtml, { singleH1: false });

// --- Colour contrast (WCAG 2.2 · 1.4.3 / 1.4.11) ------------------------
function parseColor(value, base) {
  if (!value) return null;
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return null;
  const [r, g, b, a = 1] = match[1].split(",").map((part) => parseFloat(part.trim()));
  const channel = [r, g, b];
  return channel.map((v, i) => Math.round((base?.[i] ?? 255) * (1 - a) + v * a));
}

function luminance([r, g, b]) {
  const lin = [r, g, b].map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
  if (!a || !b) return 0;
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
function tokenBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1] ?? "";
  const map = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) map[match[1]] = match[2].trim();
  return map;
}

for (const [theme, selector] of [["light", ":root"], ["dark", ".dark"]]) {
  const tokens = tokenBlock(selector);
  const bg = parseColor(tokens.bg);
  const surface = parseColor(tokens.surface) ?? bg;
  const rows = [
    ["body text on background", parseColor(tokens.fg, bg), bg, 4.5],
    ["muted text on background", parseColor(tokens.muted, bg), bg, 4.5],
    ["muted text on surface", parseColor(tokens.muted, surface), surface, 4.5],
    ["accent text on background", parseColor(tokens.accent, bg), bg, 3],
    ["accent button label", parseColor(tokens["accent-fg"]), parseColor(tokens.accent), 3],
    ["border on background", parseColor(tokens.border), bg, 0],
  ];
  for (const [label, fg, back, min] of rows) {
    const ratio = contrast(fg, back);
    const target = min === 0 ? 0 : min;
    check(
      `${theme}: contrast ${label} = ${ratio.toFixed(2)}:1 (min ${target})`,
      ratio >= target,
    );
  }
}

await prisma.$disconnect();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
