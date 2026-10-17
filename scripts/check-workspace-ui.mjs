// Verifies the workspace home gallery, sidebar tabs, discussions and calendar
// surfaces end to end.
// Usage: node --env-file=.env scripts/check-workspace-ui.mjs [baseUrl]
import http from "node:http";
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const ICS_PORT = 4323;
const prisma = new PrismaClient();

const stamp = (offsetDays, hour = 9) => {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
};

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:check-evt-1@noema",
  "SUMMARY:Design review",
  "LOCATION:Room 2",
  `DTSTART:${stamp(2)}`,
  `DTEND:${stamp(2, 10)}`,
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:check-evt-2@noema",
  "SUMMARY:All-hands",
  `DTSTART:${stamp(3, 15)}`,
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ics = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/calendar" });
  res.end(ICS);
});
await new Promise((resolve) => ics.listen(ICS_PORT, resolve));
console.log(`mock calendar listening on http://localhost:${ICS_PORT}/cal.ics`);

const results = [];
const check = (label, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const cookie = { cookie: `noema_session=${session}` };
const jsonHeaders = { ...cookie, "content-type": "application/json" };
const post = (url, body) =>
  fetch(`${base}${url}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });

const createdPages = [];
const createdThreads = [];
const createdFeeds = [];

// Clear leftovers from an interrupted previous run.
await prisma.calendarFeed.deleteMany({ where: { workspaceId: workspace.id, name: "Check calendar" } });
await prisma.chatThread.deleteMany({
  where: {
    workspaceId: workspace.id,
    OR: [
      { title: { in: ["Check thread", "Renamed check thread"] } },
      { title: "New discussion", messages: { none: {} } },
    ],
  },
});

// --- Templates API ------------------------------------------------------
const quick = await post("/api/templates", {
  action: "quickstart",
  workspaceId: workspace.id,
  kind: "database",
});
const quickBody = await quick.json();
createdPages.push(quickBody.id);
check("empty database quick start", quick.status === 200 && Boolean(quickBody.id));

const quickDb = await prisma.databaseView.findFirst({
  where: { databasePageId: quickBody.id },
  select: { type: true },
});
const quickProps = await prisma.property.count({ where: { databasePageId: quickBody.id } });
check("empty database has a table view and a Name property", quickDb?.type === "TABLE" && quickProps === 1);

const galleryRes = await post("/api/templates", {
  action: "gallery",
  workspaceId: workspace.id,
  templateId: "task-tracking",
});
const galleryBody = await galleryRes.json();
createdPages.push(galleryBody.id);
const galleryProps = await prisma.property.findMany({
  where: { databasePageId: galleryBody.id },
  select: { name: true, type: true, config: true },
});
const galleryViews = await prisma.databaseView.findMany({
  where: { databasePageId: galleryBody.id },
  select: { type: true },
});
const galleryRows = await prisma.page.count({ where: { parentId: galleryBody.id } });
check(
  "task-tracking template builds properties, board view and rows",
  galleryRes.status === 200 &&
    galleryProps.length === 4 &&
    galleryProps.some((property) => property.name === "Status" && property.type === "STATUS") &&
    galleryViews.some((view) => view.type === "BOARD") &&
    galleryRows === 3,
);

const blockRes = await post("/api/templates", {
  action: "block",
  workspaceId: workspace.id,
  templateId: "meeting",
});
const blockBody = await blockRes.json();
createdPages.push(blockBody.id);
const blockPage = await prisma.page.findUnique({
  where: { id: blockBody.id },
  select: { title: true, content: true },
});
const blockTypes = blockPage?.content?.content?.map((node) => node.type) ?? [];
check(
  "meeting block template seeds the page content",
  blockRes.status === 200 && blockTypes.includes("heading") && blockTypes.includes("taskList"),
);

const badTemplate = await post("/api/templates", {
  action: "gallery",
  workspaceId: workspace.id,
  templateId: "nope",
});
check("unknown template id is rejected", badTemplate.status === 400);

// --- Discussions --------------------------------------------------------
const anonChat = await fetch(`${base}/api/chat?workspaceId=${workspace.id}`);
check("chat API requires authentication", anonChat.status === 401);

const firstCreate = await post("/api/chat", { action: "create", workspaceId: workspace.id });
const firstThread = await firstCreate.json();
createdThreads.push(firstThread.id);
check("create a discussion", firstCreate.status === 200 && Boolean(firstThread.id));

// Clicking "New discussion" again must reopen the empty thread, not create another.
const secondCreate = await post("/api/chat", { action: "create", workspaceId: workspace.id });
const reuseBody = await secondCreate.json();
check(
  "an empty untitled discussion is reused instead of duplicated",
  reuseBody.reused === true && reuseBody.id === firstThread.id,
  `reused=${reuseBody.reused}`,
);

// The first message names the discussion (so the list is readable).
const namedMsg = await post("/api/chat", {
  action: "post",
  threadId: firstThread.id,
  body: "Quarterly planning notes",
});
const namedBody = await namedMsg.json();
check("post a message", namedMsg.status === 200, `title="${namedBody.title}"`);
check("the first message names the discussion", namedBody.title === "Quarterly planning notes");

// A titled thread feeds the rename flow.
const threadRes = await post("/api/chat", { action: "create", workspaceId: workspace.id, title: "Check thread" });
const thread = await threadRes.json();
createdThreads.push(thread.id);
const msgRes = await post("/api/chat", { action: "post", threadId: thread.id, body: "Hello from the check" });
check("a titled discussion keeps its title", msgRes.status === 200 && (await msgRes.json()).title === "Check thread");

const renameRes = await post("/api/chat", { action: "rename", threadId: thread.id, title: "Renamed check thread" });
check("rename a discussion", renameRes.status === 200);

const chatList = await fetch(`${base}/api/chat?workspaceId=${workspace.id}`, { headers: cookie }).then((r) => r.json());
const listed = chatList.threads?.find((item) => item.id === thread.id);
const namedListed = chatList.threads?.find((item) => item.id === firstThread.id);
check(
  "chat API lists threads with their messages",
  listed?.title === "Renamed check thread" &&
    listed?.messages?.[0]?.body === "Hello from the check" &&
    namedListed?.title === "Quarterly planning notes",
);

const emptyMsg = await post("/api/chat", { action: "post", threadId: thread.id, body: "   " });
check("empty messages are rejected", emptyMsg.status === 400);

// --- Calendar -----------------------------------------------------------
// A loopback feed must be **refused**: `connectCalendarFeedAction` reads feeds
// through the SSRF guard (`src/lib/feed-guard.ts`), which fails closed on private
// and reserved addresses and reports one generic message for every read failure so
// it cannot be used as a status oracle. This check used to assert that a
// `http://localhost:…` feed imported two events — i.e. that the guard did not work.
const connectRes = await post("/api/calendar", {
  action: "connect",
  workspaceId: workspace.id,
  name: "Blocked calendar",
  icsUrl: `http://localhost:${ICS_PORT}/cal.ics`,
});
const connectBody = await connectRes.json();
check(
  "a loopback feed is refused by the SSRF guard, with one generic error",
  connectRes.status === 400 && connectBody.error === "Could not read that calendar feed.",
);

const badUrl = await post("/api/calendar", {
  action: "connect",
  workspaceId: workspace.id,
  name: "Bad",
  icsUrl: "file:///etc/passwd",
});
check("non-http feed URLs are rejected", badUrl.status === 400);

// The read path is exercised with a feed written straight to the database, because
// the import path deliberately cannot be pointed at a feed from a test.
const seededFeed = await prisma.calendarFeed.create({
  data: { workspaceId: workspace.id, name: "Check calendar", icsUrl: "https://example.com/cal.ics" },
  select: { id: true },
});
createdFeeds.push(seededFeed.id);
await prisma.calendarEvent.createMany({
  data: [
    {
      workspaceId: workspace.id,
      feedId: seededFeed.id,
      uid: `verify-${Date.now()}-1`,
      title: "Design review",
      start: new Date(Date.now() + 1 * 86_400_000),
      end: new Date(Date.now() + 1 * 86_400_000 + 3_600_000),
    },
    {
      workspaceId: workspace.id,
      feedId: seededFeed.id,
      uid: `verify-${Date.now()}-2`,
      title: "All-hands",
      start: new Date(Date.now() + 2 * 86_400_000),
      end: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
    },
  ],
});

const calendarList = await fetch(`${base}/api/calendar?workspaceId=${workspace.id}`, { headers: cookie }).then((r) => r.json());
const checkFeeds = calendarList.feeds?.filter((feed) => feed.name === "Check calendar") ?? [];
const checkEvents = calendarList.events?.filter((event) => event.title === "Design review" || event.title === "All-hands") ?? [];
check(
  "calendar API returns the feed and its events",
  checkFeeds.length === 1 && checkEvents.length === 2,
);

const firstEvent = checkEvents.find((event) => event.title === "Design review") ?? checkEvents[0];
const notesRes = await post("/api/calendar", { action: "notes", eventId: firstEvent.id });
const notes = await notesRes.json();
createdPages.push(notes.id);
const notesPage = await prisma.page.findUnique({
  where: { id: notes.id },
  select: { title: true, icon: true },
});
const linked = await prisma.calendarEvent.findUnique({
  where: { id: firstEvent.id },
  select: { notesPageId: true },
});
check(
  "meeting notes page is created and linked to the event",
  notesRes.status === 200 &&
    notesPage?.icon === "📅" &&
    notesPage?.title.includes(firstEvent.title) &&
    linked?.notesPageId === notes.id,
);

const secondCall = await post("/api/calendar", { action: "notes", eventId: firstEvent.id });
const secondBody = await secondCall.json();
check("meeting notes are reused, not duplicated", secondBody.existing === true && secondBody.id === notes.id);

const refreshRes = await post("/api/calendar", { action: "refresh", workspaceId: workspace.id });
const refreshBody = await refreshRes.json();
// A feed that cannot be read must not break refresh: it answers 200 and reports the
// outcome. (The seeded feed points at a host this environment cannot reach, which is
// the case worth pinning — the alternative would be asserting that the SSRF guard
// lets a loopback feed through, which it must not.)
check(
  "refresh tolerates a feed it cannot read",
  refreshRes.status === 200 && typeof refreshBody.refreshed === "number",
);

// --- Rendered surfaces --------------------------------------------------
const page = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, parentId: null, deletedAt: null },
  select: { id: true },
});

const homeHtml = await fetch(`${base}/w/${workspace.slug}`, { headers: cookie }).then((r) => r.text());
const galleryLabels = [
  "Empty page",
  "Empty database",
  "Templates",
  "Task tracking",
  "Projects",
  "Skills",
  "Document center",
  "Brainstorm session",
  "Meeting notes",
  "Other templates",
];
check(
  "home renders the template gallery",
  galleryLabels.every((label) => homeHtml.includes(label)),
);
check(
  "home greets the signed-in user",
  /Good (morning|afternoon|evening)/.test(homeHtml) && homeHtml.includes(user.name.split(" ")[0]),
);

const sidebarHtml = await fetch(`${base}/w/${workspace.slug}/${page.id}`, { headers: cookie }).then((r) => r.text());
check(
  "sidebar exposes the tab bar and panels",
  sidebarHtml.includes('aria-label="Sidebar navigation"') &&
    sidebarHtml.includes("Library") &&
    sidebarHtml.includes("Private pages") &&
    sidebarHtml.includes("Customize sidebar") &&
    // The shortcut hint renders through `<Kbd>`, which emits one element per key
    // ("Ctrl" and "K"), so the contiguous string "Ctrl K" is never in the HTML.
    /data-slot="kbd-group"/.test(sidebarHtml) &&
    sidebarHtml.includes("Quick find"),
);
check(
  "sidebar renders the discussions and calendar panels",
  sidebarHtml.includes("Renamed check thread") &&
    sidebarHtml.includes("Hello from the check") &&
    sidebarHtml.includes("Upcoming events") &&
    sidebarHtml.includes("Design review"),
);

const libraryHtml = await fetch(`${base}/w/${workspace.slug}/library`, { headers: cookie }).then((r) => r.text());
check(
  "library page lists databases and pages",
  libraryHtml.includes(">Library<") && libraryHtml.includes("Databases") && libraryHtml.includes("Task tracking"),
);

// --- Comments (selection quote) -----------------------------------------
const commentTarget = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, parentId: null, deletedAt: null },
  select: { id: true },
});
const plantedComment = await prisma.comment.create({
  data: {
    pageId: commentTarget.id,
    authorId: user.id,
    body: "Check comment body",
    quote: "Check quoted selection",
  },
  select: { id: true },
});
const commentHtml = await fetch(`${base}/w/${workspace.slug}/${commentTarget.id}`, { headers: cookie }).then((r) => r.text());
check(
  "comments render with the anchored quote",
  commentHtml.includes("Check comment body") && commentHtml.includes("Check quoted selection"),
);
check(
  "the comment composer is wired for the editor's Comment action",
  commentHtml.includes("data-comment-input"),
);
await prisma.comment.deleteMany({ where: { id: plantedComment.id } });

// --- Cleanup ------------------------------------------------------------
for (const id of createdPages.filter(Boolean)) {
  await prisma.page.deleteMany({ where: { id } });
}
await prisma.chatThread.deleteMany({ where: { id: { in: createdThreads } } });
await prisma.calendarFeed.deleteMany({ where: { id: { in: createdFeeds } } });
await prisma.$disconnect();
ics.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
