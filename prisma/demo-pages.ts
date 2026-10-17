/**
 * The demo workspace's page tree: every document the seed creates, authored
 * with the builders in `demo-blocks.ts`.
 *
 * The goal is a workspace that reads like a real product team's — a handbook,
 * meeting notes, specs, research and onboarding — so the screenshots and the
 * public demo account show the app with believable content instead of lorem
 * ipsum. Everything is additive: the two original pages ("Getting started",
 * "Editor tips") and the original "Product roadmap" database are preserved
 * exactly as they were so the smoke test and the e2e suite keep passing.
 *
 * `key` is a seed-local handle used to resolve parents and to attach projects,
 * teamspaces, comments and favourites after the rows exist.
 */

import {
  bold,
  bookmark,
  bulletList,
  callout,
  code,
  codeBlock,
  columns,
  divider,
  doc,
  h1,
  h2,
  h3,
  highlight,
  image,
  italic,
  link,
  mention,
  orderedList,
  p,
  pullQuote,
  quote,
  table,
  text,
  todoList,
  toggle,
  type Block,
  type Doc,
} from "./demo-blocks";

export type PageSpec = {
  key: string;
  title: string;
  icon: string;
  /** `key` of the parent page (omit for a top-level page). */
  parent?: string;
  /** `key` of the teamspace this page lives in. */
  teamspace?: string;
  /** `key` of the project this page is attached to. */
  project?: string;
  cover?: string;
  fullWidth?: boolean;
  favorite?: boolean;
  locked?: boolean;
  content: Doc;
};

const cover = (id: string) =>
  `https://images.unsplash.com/${id}?w=1600&q=80&auto=format&fit=crop`;
const photo = (id: string) =>
  `https://images.unsplash.com/${id}?w=1200&q=80&auto=format&fit=crop`;

export const PHOTOS = {
  team: "photo-1522071820081-009f0129c71c",
  desk: "photo-1531297484001-80022131f5a1",
  office: "photo-1497366754035-f200968a6e72",
  whiteboard: "photo-1552664730-d307ca884978",
  design: "photo-1517245386807-bb43f82c33c4",
  analytics: "photo-1460925895917-afdab827c52f",
  laptops: "photo-1519389950473-47ba0277781c",
  charts: "photo-1454165804606-c3d57bc86b40",
  workspace: "photo-1504384308090-c894fdcc538d",
  meeting: "photo-1517048676732-d65bc937f952",
} as const;

/** The demo workspace's own URL — used in bookmark and link blocks. */
const REPO = "https://github.com/your-org/noema";

export const pageSpecs: PageSpec[] = [
  /* ------------------------------------------------------------ product */
  {
    key: "product",
    title: "Product",
    icon: "🧭",
    teamspace: "product",
    content: doc(
      p(
        text("Everything the product team owns: the roadmap, specs, release notes and "),
        text("the metrics we hold ourselves to."),
      ),
      callout(
        "🧭",
        "blue",
        p(
          bold("Start here. "),
          text(
            "The roadmap is the source of truth for what we are building this quarter; the specs explain how.",
          ),
        ),
      ),
      h2("This quarter"),
      bulletList(
        [text("Q4 2026 roadmap — "), link("planning board", REPO)],
        [text("Spec: inline databases — the flagship v2.0 feature")],
        [text("Release notes — v2.0 (shipped 14 Oct 2026)")],
      ),
      h2("How we run product"),
      orderedList(
        [text("Discovery — talk to at least five customers before writing a spec.")],
        [text("Spec — one page, one problem, explicit non-goals.")],
        [text("Build — ship behind a flag, dogfood for a week.")],
        [text("Measure — adoption, not vanity metrics.")],
      ),
      divider(),
      p(italic("Owned by "), mention("Amara Okafor", "user-amara"), italic(" · updated weekly.")),
    ),
  },
  {
    key: "roadmap-q4",
    title: "Q4 2026 roadmap",
    icon: "🎯",
    parent: "product",
    project: "atlas",
    cover: cover(PHOTOS.charts),
    favorite: true,
    content: doc(
      p(
        text(
          "Our theme this quarter is ",
        ),
        bold("making databases feel native everywhere"),
        text(
          " — in a page, in a comment, in the sidebar. Three bets, one number: 40% of weekly active workspaces using an inline database by 31 December.",
        ),
      ),
      callout(
        "📌",
        "yellow",
        p(
          bold("North star: "),
          text(
            "weekly active workspaces with at least one inline database. Baseline 18% (30 Sep), target 40% (31 Dec).",
          ),
        ),
      ),
      h2("The three bets"),
      h3("1. Inline databases"),
      p(
        text("A linked database that renders inside any page with its own view switcher, filters and sorts. "),
        text("This is the feature customers ask for most in support threads."),
      ),
      h3("2. Faster long documents"),
      p(text("Virtualise the block list so a 5,000-block page stays under 16 ms per keystroke.")),
      h3("3. Public API v1"),
      p(
        text("Read and write pages, databases and tickets over a documented REST API with scoped tokens."),
      ),
      h2("Milestones"),
      table(
        [[bold("Milestone")], [bold("Owner")], [bold("Due")], [bold("Status")]],
        [
          [[text("Inline databases in beta")], [text("Louis Marchand")], [text("31 Oct")], [text("On track")]],
          [[text("Virtualised editor")], [text("Tomás Ferreira")], [text("14 Nov")], [text("At risk")]],
          [[text("Public API v1")], [text("Priya Raman")], [text("12 Dec")], [text("Not started")]],
        ],
      ),
      h2("Explicitly not this quarter"),
      bulletList(
        [text("Offline-first sync — the local-first desktop build covers the important cases.")],
        [text("A native mobile editor — the responsive web app is the mobile story.")],
      ),
      quote(
        text("“If a feature does not make the workspace easier to live in every day, it waits.”"),
      ),
    ),
  },
  {
    key: "release-notes-2",
    title: "Release notes — v2.0",
    icon: "🚀",
    parent: "product",
    project: "atlas",
    content: doc(
      p(
        text("Shipped "),
        bold("14 October 2026"),
        text(" to every workspace. The desktop app updates itself on next launch."),
      ),
      callout(
        "✅",
        "green",
        p(
          bold("Highlights: "),
          text(
            "inline databases, a faster editor on long pages, workspace-wide search across tickets, and a redesigned settings surface.",
          ),
        ),
      ),
      h2("New"),
      bulletList(
        [
          text("Inline databases — drop a linked view of any database inside a page and give it its own filters, sorts and layout."),
        ],
        [text("Chart views — summarise any database by group with bar, line and donut charts.")],
        [text("Templates — reusable page blueprints, including recurring database templates.")],
        [text("Timeline view with drag-to-reschedule.")],
      ),
      h2("Improved"),
      bulletList(
        [text("Search now covers ticket titles, comments and page content in one query.")],
        [text("The sidebar renders instantly on workspaces with more than 2,000 pages.")],
        [text("Board views remember per-column WIP limits.")],
        [text("Export to Markdown keeps nested pages and databases intact.")],
      ),
      h2("Fixed"),
      bulletList(
        [text("Login no longer redirects in a loop when a session cookie expires mid-request.")],
        [text("Bookmark previews fall back to the page title when metadata is blocked.")],
        [text("Dates in tables now render identically on the server and the client.")],
      ),
      h2("Upgrade notes"),
      callout(
        "⚠️",
        "orange",
        p(
          text("Run "),
          code("prisma migrate deploy"),
          text(
            " before starting v2.0. The migration adds the new view types and is safe to run twice.",
          ),
        ),
      ),
      codeBlock(
        "bash",
        "# hosted\nnpx prisma migrate deploy && npm run build && npm start\n\n# desktop\n# the app migrates its embedded database on launch",
      ),
      divider(),
      p(
        italic("Thanks to "),
        mention("Amara Okafor", "user-amara"),
        italic(", "),
        mention("Louis Marchand", "user-louis"),
        italic(" and "),
        mention("Priya Raman", "user-priya"),
        italic(" for shipping this one."),
      ),
    ),
  },
  {
    key: "spec-inline-db",
    title: "Spec: inline databases",
    icon: "🧩",
    parent: "product",
    project: "atlas",
    favorite: true,
    content: doc(
      p(
        text("Status: "),
        highlight("in review"),
        text("  ·  Author: "),
        mention("Louis Marchand", "user-louis"),
        text("  ·  Reviewers: "),
        mention("Amara Okafor", "user-amara"),
        text(", "),
        mention("Priya Raman", "user-priya"),
      ),
      callout(
        "🧩",
        "purple",
        p(
          bold("Problem. "),
          text(
            "People keep a database in one page and then need the same rows in a project brief. Today they duplicate the data by hand and it drifts within a week.",
          ),
        ),
      ),
      h2("Goals"),
      bulletList(
        [text("Render any database inside any page as a first-class block.")],
        [text("Let each embedded instance keep its own views, filters, sorts and layout.")],
        [text("Edits in the embedded view write to the source database — one copy of the truth.")],
      ),
      h2("Non-goals"),
      bulletList(
        [text("Cross-workspace databases.")],
        [text("Two-way sync with an external system.")],
      ),
      h2("Design"),
      columns(
        [
          h3("Data model"),
          p(
            text(
              "A new ",
            ),
            code("linkedDatabase"),
            text(
              " node stores the source page id plus an optional saved view. Rows stay owned by the source database.",
            ),
          ),
        ],
        [
          h3("Access"),
          p(
            text(
              "The embed inherits the source database's permissions. If a reader cannot open the source, the embed renders a lock, never the rows.",
            ),
          ),
        ],
      ),
      h2("Open questions"),
      todoList(
        ["Do embedded views need their own share links, or inherit the host page's?", false],
        ["How do we render a chart view inside a 400px-wide column?", false],
        ["Should the embed count toward the workspace's database limit?", true],
      ),
      h2("Reference"),
      codeBlock(
        "typescript",
        "// The block stores a pointer, not a copy.\ntype LinkedDatabaseAttrs = {\n  sourcePageId: string;\n  viewId: string | null; // null = the source's default view\n  layout: \"full\" | \"compact\";\n};",
      ),
      bookmark(
        REPO,
        "your-org/noema",
        "An original, open-source, self-hosted workspace for notes, docs and databases.",
        "github.com",
      ),
    ),
  },

  /* ---------------------------------------------------------- marketing */
  {
    key: "marketing",
    title: "Marketing",
    icon: "📣",
    teamspace: "marketing",
    content: doc(
      p(text("Positioning, launches and the content calendar. Every claim we publish has to be something the product actually does — no vapourware.")),
      h2("Live this quarter"),
      bulletList(
        [text("Launch plan — v2.0")],
        [text("Brand voice & tone")],
        [text("Content calendar (database)")],
      ),
    ),
  },
  {
    key: "launch-plan",
    title: "Launch plan — v2.0",
    icon: "🚀",
    parent: "marketing",
    project: "website",
    cover: cover(PHOTOS.meeting),
    content: doc(
      p(
        text("Launch day: "),
        bold("Tuesday 20 October 2026"),
        text(". One story, three channels, no paid spend."),
      ),
      callout(
        "🎯",
        "blue",
        p(
          bold("The one-line story: "),
          text(
            "“Your databases, inside your documents.” Everything we publish supports that sentence.",
          ),
        ),
      ),
      h2("Timeline"),
      table(
        [[bold("When")], [bold("What")], [bold("Owner")], [bold("Done")]],
        [
          [[text("Mon 19 Oct")], [text("Changelog + docs published")], [text("Priya Raman")], [text("☑")]],
          [[text("Tue 20 Oct, 09:00")], [text("Blog post + demo video")], [text("Sofia Lindqvist")], [text("☐")]],
          [[text("Tue 20 Oct, 14:00")], [text("Community post + newsletter")], [text("Amara Okafor")], [text("☐")]],
          [[text("Wed 21 Oct")], [text("Follow-up thread with three customer stories")], [text("Sofia Lindqvist")], [text("☐")]],
        ],
      ),
      h2("Assets"),
      todoList(
        ["60-second demo video (screen recording + captions)", true],
        ["Six screenshots at 2× for the changelog", true],
        ["Blog post, ~900 words, with the roadmap screenshot", false],
        ["Newsletter draft (subject line A/B)", false],
      ),
      h2("Draft copy"),
      toggle(
        "Blog post — opening paragraph",
        p(
          text(
            "“For two years, our most requested feature has been the same sentence: ‘I want my database inside my document.’ Today it ships. In v2.0 you can drop any database into any page, give it its own views, and keep a single copy of the truth.”",
          ),
        ),
      ),
      toggle(
        "Newsletter — subject lines",
        orderedList(
          [text("Your databases, inside your documents")],
          [text("v2.0: databases everywhere, and a much faster editor")],
        ),
      ),
      divider(),
      p(italic("Last reviewed 12 Oct 2026 by "), mention("Amara Okafor", "user-amara")),
    ),
  },
  {
    key: "brand-voice",
    title: "Brand voice & tone",
    icon: "🎨",
    parent: "marketing",
    project: "website",
    content: doc(
      pullQuote(text("Clear, specific, and never louder than the product.")),
      h2("We sound like"),
      bulletList(
        [text("A senior colleague explaining something once, well.")],
        [text("Confident about what ships; honest about what does not.")],
        [text("Plain words over jargon: “page”, not “entity”.")],
      ),
      h2("We avoid"),
      bulletList(
        [text("Superlatives we cannot measure (“blazingly fast”, “revolutionary”).")],
        [text("Feature lists with no user in them.")],
        [text("Emoji in headings outside of launch posts.")],
      ),
      h2("Words we use"),
      table(
        [[bold("Use")], [bold("Instead of")]],
        [
          [[text("workspace")], [text("tenant, org, account")]],
          [[text("page")], [text("document, node, entity")]],
          [[text("database")], [text("table, collection, dataset")]],
          [[text("ticket")], [text("issue (only in API responses)")]],
        ],
      ),
      callout(
        "✍️",
        "gray",
        p(
          text("Before publishing, read it aloud. If a sentence needs a second breath, split it."),
        ),
      ),
      image(photo(PHOTOS.design), "A printed brand sheet on a desk", "The tone sheet, printed for the studio wall."),
    ),
  },

  /* ----------------------------------------------------------- meetings */
  {
    key: "meetings",
    title: "Meeting notes",
    icon: "🗓️",
    content: doc(
      p(
        text(
          "One page per meeting. Decisions at the top, action items at the bottom with an owner and a date — nothing else.",
        ),
      ),
      callout(
        "🧾",
        "gray",
        p(
          bold("Format: "),
          text(
            "Attendees · Agenda · Decisions · Action items. If a meeting has no decisions or actions, it did not need to be a meeting.",
          ),
        ),
      ),
    ),
  },
  {
    key: "sync-12-oct",
    title: "Weekly sync — 12 Oct 2026",
    icon: "📝",
    parent: "meetings",
    teamspace: "product",
    content: doc(
      p(
        text("Attendees: "),
        mention("Amara Okafor", "user-amara"),
        text(", "),
        mention("Louis Marchand", "user-louis"),
        text(", "),
        mention("Priya Raman", "user-priya"),
        text(", "),
        mention("Tomás Ferreira", "user-tomas"),
        text("  ·  45 min  ·  "),
        link("Recording", REPO),
      ),
      h2("Agenda"),
      orderedList(
        [text("v2.0 launch readiness")],
        [text("Editor performance on long pages")],
        [text("Hiring — two open roles")],
      ),
      h2("Decisions"),
      callout(
        "✅",
        "green",
        orderedList(
          [text("Ship v2.0 on 20 October, not the 16th — the docs need one more pass.")],
          [text("Freeze the schema on Wednesday; anything after that waits for v2.1.")],
          [text("The performance work is not a launch blocker. It ships behind a flag.")],
        ),
      ),
      h2("Discussion"),
      h3("Editor performance"),
      p(
        text(
          "Tomás walked through the profile: a 5,000-block page spends 42 ms per keystroke in layout. Virtualising the block list brings it to 11 ms in the prototype. The team agreed to land it behind ",
        ),
        code("editor.virtualise"),
        text(" and measure on real workspaces before removing the flag."),
      ),
      h3("Hiring"),
      p(
        text(
          "Two roles open: a founding designer and a support engineer. Amara will write both specs this week so the postings can go out before the launch.",
        ),
      ),
      h2("Action items"),
      todoList(
        [[mention("Amara Okafor", "user-amara"), text(" — final pass on the launch post")], false],
        [[mention("Louis Marchand", "user-louis"), text(" — freeze the schema and tag the release")], false],
        [[mention("Tomás Ferreira", "user-tomas"), text(" — flag the virtualised editor")], true],
        [[mention("Priya Raman", "user-priya"), text(" — write the two role specs")], false],
      ),
      divider(),
      p(italic("Next sync: Monday 19 Oct, 09:30.")),
    ),
  },
  {
    key: "design-review-09-oct",
    title: "Design review — 09 Oct 2026",
    icon: "🎨",
    parent: "meetings",
    teamspace: "product",
    content: doc(
      p(
        text("Attendees: "),
        mention("Priya Raman", "user-priya"),
        text(", "),
        mention("Amara Okafor", "user-amara"),
        text(", "),
        mention("Louis Marchand", "user-louis"),
      ),
      h2("What we reviewed"),
      bulletList(
        [text("Inline database block — default layout and empty state.")],
        [text("Settings → Data: the export and import flow.")],
        [text("The new chart view palette.")],
      ),
      h2("Feedback"),
      callout(
        "💬",
        "yellow",
        bulletList(
          [
            text("The embedded database needs a visible “source” affordance — people will otherwise edit a view thinking it is a copy."),
          ],
          [text("Charts should use the workspace accent, not a fixed palette, so they match the theme.")],
          [text("Export screen: put the destructive options behind a disclosure, not next to the happy path.")],
        ),
      ),
      h2("Decisions"),
      bulletList(
        [text("Source chip in the embed's header, linking back to the database.")],
        [text("Chart series derive from the grouped property's option colours.")],
        [text("Export: “Everything” first, destructive options collapsed.")],
      ),
      image(photo(PHOTOS.whiteboard), "A whiteboard covered in interface sketches", "Review board, 09 Oct."),
    ),
  },

  /* ---------------------------------------------------------- handbook */
  {
    key: "handbook",
    title: "Company handbook",
    icon: "📘",
    favorite: true,
    content: doc(
      p(
        text(
          "How we work, what we promise each other, and where the money goes. Written to be read on day one and useful on day five hundred.",
        ),
      ),
      callout(
        "📘",
        "blue",
        p(
          text("This handbook is a living document. If something here is wrong or missing, fix it — that is the whole policy."),
        ),
      ),
      h2("Contents"),
      bulletList(
        [text("Mission & values")],
        [text("How we work")],
        [text("Time off & benefits")],
        [text("Expense policy")],
      ),
    ),
  },
  {
    key: "mission-values",
    title: "Mission & values",
    icon: "🧭",
    parent: "handbook",
    content: doc(
      pullQuote(
        text("Help teams think together, in one place, without the tool getting in the way."),
      ),
      p(
        text(
          "We build a workspace where a note, a document and a database are the same object — so a team never has to decide where something belongs before writing it down.",
        ),
      ),
      h2("The five values"),
      h3("1. Written first"),
      p(
        text(
          "If it matters, it is written down where everyone can find it. Meetings are for decisions, not for information transfer.",
        ),
      ),
      h3("2. Small, reversible steps"),
      p(
        text(
          "Prefer the change you can undo in a minute. Flags, not rewrites; migrations, not resets.",
        ),
      ),
      h3("3. Craft over volume"),
      p(
        text(
          "One feature that feels inevitable beats five that feel approximate. We would rather ship late than ship vague.",
        ),
      ),
      h3("4. Default to open"),
      p(
        text(
          "The product is open source, the roadmap is public, and internal docs are readable by everyone in the company by default.",
        ),
      ),
      h3("5. Respect the reader"),
      p(
        text("Short sentences. No jargon. No dark patterns. Ever."),
      ),
      divider(),
      columns(
        [
          callout(
            "🌱",
            "green",
            p(bold("What we optimise for")),
            p(text("Time to a useful page. A new workspace should feel productive in under two minutes.")),
          ),
        ],
        [
          callout(
            "🚫",
            "red",
            p(bold("What we refuse")),
            p(text("Lock-in. Export is complete, documented and never behind a paywall.")),
          ),
        ],
      ),
    ),
  },
  {
    key: "how-we-work",
    title: "How we work",
    icon: "🛠️",
    parent: "handbook",
    content: doc(
      p(text("A small, remote-first team. Four rituals, one rule about meetings.")),
      callout(
        "⏱️",
        "orange",
        p(
          bold("The rule: "),
          text(
            "no meeting without a written agenda and a named decision. If it can be a document, it is a document.",
          ),
        ),
      ),
      h2("The rituals"),
      toggle(
        "Monday — weekly sync (45 min)",
        p(text("Each team reports three things: what shipped, what is blocked, what needs a decision.")),
        bulletList(
          [text("Decisions are recorded in that week's meeting note within an hour.")],
          [text("Anything without an owner is deleted, not deferred.")],
        ),
      ),
      toggle(
        "Wednesday — deep work (no meetings)",
        p(text("The whole company keeps Wednesday free of calls. It is the single most popular policy we have.")),
      ),
      toggle(
        "Thursday — demo (30 min)",
        p(text("Anyone can demo anything, including a failed experiment. Demos are recorded for people in other timezones.")),
      ),
      toggle(
        "Friday — written update",
        p(text("A short note in the company page: what moved, what did not, and what next week looks like.")),
      ),
      h2("Where things live"),
      table(
        [[bold("Artifact")], [bold("Where")], [bold("Owner")]],
        [
          [[text("Roadmap")], [text("Product → Q4 roadmap")], [text("Amara")]],
          [[text("Specs")], [text("Product")], [text("Author of the spec")]],
          [[text("Decisions")], [text("Meeting notes")], [text("Whoever ran the meeting")]],
          [[text("Bugs")], [text("Tickets → Bug tracker")], [text("On-call engineer")]],
          [[text("Handbook")], [text("Company handbook")], [text("Everyone")]],
        ],
      ),
    ),
  },
  {
    key: "time-off",
    title: "Time off & benefits",
    icon: "🌴",
    parent: "handbook",
    content: doc(
      callout(
        "🌴",
        "green",
        p(
          bold("The short version: "),
          text(
            "take the time you need, tell people early, and put it in the team calendar. There is no approval process.",
          ),
        ),
      ),
      h2("Holiday"),
      table(
        [[bold("Region")], [bold("Days")], [bold("Notes")]],
        [
          [[text("EU")], [text("30")], [text("Plus public holidays; carry over up to 5 days")]],
          [[text("UK")], [text("28")], [text("Plus public holidays")]],
          [[text("US")], [text("25")], [text("Plus federal holidays")]],
        ],
      ),
      h2("Other leave"),
      bulletList(
        [text("Parental — 20 weeks at full pay, for every parent, however the child arrives.")],
        [text("Sick — as long as you need; a message in the morning is enough.")],
        [text("Sabbatical — one month unpaid after three years, with your role held.")],
      ),
      h2("Equipment & learning"),
      bulletList(
        [text("A laptop of your choice, refreshed every three years.")],
        [text("€1,500 a year for learning: courses, books, conferences.")],
        [text("Home office budget of €800, once, no receipts needed under €100.")],
      ),
      quote(text("We measure output over months, not hours over days.")),
    ),
  },
  {
    key: "expenses",
    title: "Expense policy",
    icon: "💳",
    parent: "handbook",
    content: doc(
      p(
        text(
          "Spend the company's money the way you would spend your own on something you care about: carefully, and without needing permission for the obvious things.",
        ),
      ),
      h2("No approval needed"),
      table(
        [[bold("Category")], [bold("Limit")], [bold("Example")]],
        [
          [[text("Travel")], [text("€250 per trip")], [text("Train to a customer meeting")]],
          [[text("Software")], [text("€50 / month")], [text("A tool that clearly saves you time")]],
          [[text("Books & courses")], [text("€200")], [text("A course relevant to your work")]],
          [[text("Team lunch")], [text("€30 / person")], [text("A working lunch with a customer")]],
        ],
      ),
      h2("Ask first"),
      bulletList(
        [text("Anything over €1,000.")],
        [text("Anything recurring beyond one quarter.")],
        [text("Flights, unless the train takes more than six hours.")],
      ),
      callout(
        "🧾",
        "gray",
        p(
          text("Submit within 30 days with a receipt. Expenses older than 90 days cannot be processed for accounting reasons."),
        ),
      ),
      h2("How to submit"),
      orderedList(
        [text("Export the receipt as a PDF or a clear photo.")],
        [text("Add it to the Finance page with the category and amount.")],
        [text("Expect reimbursement in the next payroll run.")],
      ),
    ),
  },

  /* -------------------------------------------------------------- goals */
  {
    key: "okrs",
    title: "OKRs — Q4 2026",
    icon: "🎯",
    teamspace: "product",
    favorite: true,
    content: doc(
      p(
        text("Three objectives. Each one has a number and a name against it, and we review them in the weekly sync — not at the end of the quarter."),
      ),
      h2("O1 — Databases become the reason people stay"),
      table(
        [[bold("Key result")], [bold("Baseline")], [bold("Target")], [bold("Owner")]],
        [
          [[text("Workspaces using an inline database weekly")], [text("18%")], [text("40%")], [text("Amara")]],
          [[text("Median time to build a first database")], [text("9 min")], [text("3 min")], [text("Priya")]],
          [[text("Database-related support threads")], [text("62 / mo")], [text("20 / mo")], [text("Louis")]],
        ],
      ),
      h2("O2 — The editor disappears"),
      table(
        [[bold("Key result")], [bold("Baseline")], [bold("Target")], [bold("Owner")]],
        [
          [[text("Keystroke latency on a 5,000-block page")], [text("42 ms")], [text("< 16 ms")], [text("Tomás")]],
          [[text("Page open time (p75)")], [text("820 ms")], [text("< 400 ms")], [text("Tomás")]],
          [[text("Editor crash-free sessions")], [text("99.4%")], [text("99.9%")], [text("Louis")]],
        ],
      ),
      h2("O3 — A team can adopt us without a call"),
      table(
        [[bold("Key result")], [bold("Baseline")], [bold("Target")], [bold("Owner")]],
        [
          [[text("Workspaces with 3+ members in week one")], [text("34%")], [text("55%")], [text("Sofia")]],
          [[text("Docs pages read before first page created")], [text("1.2")], [text("3")], [text("Sofia")]],
        ],
      ),
      callout(
        "📊",
        "blue",
        p(
          text("Progress is reviewed every Monday from the numbers in "),
          link("the analytics board", REPO),
          text(" — never from memory."),
        ),
      ),
    ),
  },

  /* ----------------------------------------------------------- research */
  {
    key: "research",
    title: "Research",
    icon: "🧪",
    teamspace: "product",
    content: doc(
      p(
        text(
          "Interview notes and usability findings, kept verbatim where it matters. We quote customers rather than summarising them into our own opinions.",
        ),
      ),
      callout(
        "🔎",
        "purple",
        p(
          bold("Rule: "),
          text(
            "every finding links to the session it came from, and every session lists the tasks the participant actually attempted.",
          ),
        ),
      ),
      h2("Recent"),
      bulletList(
        [text("User interviews — September 2026 (8 sessions, 5 companies)")],
        [text("Usability findings — inline databases (12 sessions)")],
      ),
    ),
  },
  {
    key: "interviews-sept",
    title: "User interviews — September 2026",
    icon: "🎤",
    parent: "research",
    project: "atlas",
    content: doc(
      p(
        text("8 sessions · 5 companies · 40-minute calls · participants paid €60. Sessions were recorded with consent; quotes are anonymised."),
      ),
      h2("Who we spoke to"),
      table(
        [[bold("Participant")], [bold("Role")], [bold("Team size")], [bold("Uses")]],
        [
          [[text("P1")], [text("Product lead")], [text("14")], [text("Roadmap + meeting notes")]],
          [[text("P2")], [text("Engineering manager")], [text("9")], [text("Sprint tracking")]],
          [[text("P3")], [text("Designer")], [text("6")], [text("Research repository")]],
          [[text("P4")], [text("Founder")], [text("3")], [text("Everything")]],
          [[text("P5")], [text("Ops")], [text("40")], [text("Handbook + processes")]],
        ],
      ),
      h2("What we heard"),
      quote(
        text("“I keep the roadmap in one page and the project brief in another, and then I copy the rows across. It is always wrong by Friday.”"),
        text(" — P2, engineering manager"),
      ),
      bulletList(
        [text("Four of five teams duplicate the same rows across at least two pages.")],
        [text("Nobody used the existing “linked view” because it looked read-only.")],
        [text("Search was praised; filtering inside search was the most requested addition.")],
        [text("Three teams had given up on a second tool for tickets and run them in a database.")],
      ),
      h2("What we are doing about it"),
      orderedList(
        [text("Inline databases ship in v2.0 with an explicit “source” affordance.")],
        [text("The embed's empty state explains that edits write through to the source.")],
        [text("Search filters are on the v2.1 list, not this quarter.")],
      ),
      callout(
        "🧠",
        "yellow",
        p(
          text("The most useful question was the dumbest one: “show me what you did yesterday.” Every workaround appeared within two minutes."),
        ),
      ),
    ),
  },
  {
    key: "usability-findings",
    title: "Usability findings",
    icon: "🔍",
    parent: "research",
    project: "atlas",
    content: doc(
      p(text("12 sessions against the inline-database prototype. Severity is how often it blocked the task.")),
      h2("Findings"),
      table(
        [[bold("Severity")], [bold("Finding")], [bold("Fix")]],
        [
          [
            [text("High")],
            [text("People edited an embedded view believing they were editing a copy.")],
            [text("Source chip + “edits write through” empty state")],
          ],
          [
            [text("High")],
            [text("The view switcher was mistaken for a filter menu.")],
            [text("Rename to “Layout”, move filters to their own control")],
          ],
          [
            [text("Medium")],
            [text("Charts were read as decoration, not data.")],
            [text("Add axis labels and a value tooltip")],
          ],
          [
            [text("Low")],
            [text("The embed's header felt heavy in a narrow column.")],
            [text("Compact layout below 480px")],
          ],
        ],
      ),
      h2("Method notes"),
      bulletList(
        [text("Tasks: find last week's decisions, add a row, change the layout, share the page.")],
        [text("Two facilitators; one took notes in this page, the other ran the session.")],
        [text("Success was measured as “completed without help”, not as satisfaction.")],
      ),
      callout(
        "📐",
        "orange",
        p(
          bold("Threshold: "),
          text(
            "any finding that blocked more than a third of participants had to be fixed before beta. Two did.",
          ),
        ),
      ),
      todoList(
        ["Source chip in the embed header", true],
        ["Rename the view switcher to “Layout”", true],
        ["Axis labels and tooltips on charts", false],
        ["Compact embed layout", false],
      ),
    ),
  },

  /* --------------------------------------------------------- onboarding */
  {
    key: "onboarding",
    title: "Onboarding",
    icon: "📄",
    content: doc(
      p(text("Everything a new joiner needs in their first week. If you have to ask where something is, it belongs on this page.")),
      callout(
        "👋",
        "green",
        p(
          bold("Welcome. "),
          text(
            "Your first task is to improve this page — add the thing you could not find.",
          ),
        ),
      ),
    ),
  },
  {
    key: "day-one",
    title: "Day one checklist",
    icon: "✅",
    parent: "onboarding",
    content: doc(
      p(text("Work through this in order. It should take about two hours, including the coffee.")),
      todoList(
        ["Sign in and set your name, avatar and timezone", false],
        ["Read Mission & values, then How we work", false],
        ["Say hello in the team chat thread", false],
        ["Pick a first ticket from the backlog and assign it to yourself", false],
        ["Pair with your onboarding buddy for an hour", false],
        ["Book a 1:1 with your manager for the end of week one", false],
      ),
      h2("Your accounts"),
      table(
        [[bold("Service")], [bold("Access")], [bold("Notes")]],
        [
          [[text("Workspace")], [text("Member")], [text("Ask an admin to upgrade you if needed")]],
          [[text("Repository")], [text("Write")], [text("Invite arrives by email")]],
          [[text("Design files")], [text("Comment")], [text("Read-only until week two")]],
        ],
      ),
      callout(
        "🤝",
        "blue",
        p(
          text("Your buddy answers any question, however small. There is no such thing as a stupid one in week one."),
        ),
      ),
    ),
  },
  {
    key: "tools",
    title: "Tools we use",
    icon: "🧰",
    parent: "onboarding",
    content: doc(
      p(text("A short list on purpose. Every tool has to earn its place, and every one has an exit path.")),
      table(
        [[bold("Job")], [bold("Tool")], [bold("Owner")], [bold("Notes")]],
        [
          [[text("Docs & databases")], [text("Noema")], [text("Everyone")], [text("The one we build")]],
          [[text("Tickets")], [text("Noema tickets")], [text("Louis")], [text("Cycles, labels, estimates")]],
          [[text("Chat")], [text("Noema chat")], [text("Everyone")], [text("Threads per topic")]],
          [[text("Source")], [text("GitHub")], [text("Tomás")], [text("Trunk-based, review required")]],
          [[text("Design")], [text("Figma")], [text("Priya")], [text("One file per project")]],
        ],
      ),
      h2("Conventions"),
      bulletList(
        [text("Anything longer than a paragraph goes in a page, not in chat.")],
        [text("Decisions get a ticket so they can be found later.")],
        [text("If a tool is not on this page, it is not approved — ask before subscribing.")],
      ),
      image(photo(PHOTOS.desk), "A tidy desk with a laptop and a notebook", "The studio desk, Monday morning."),
    ),
  },
];

/** Extra content blocks prepended to database pages (the intro above the view). */
export const databaseIntros: Record<string, Block[]> = {
  roadmap: [
    p(
      text(
        "What we plan to ship, in order. Grouped by status; the Timeline view shows the target dates.",
      ),
    ),
  ],
  tasks: [
    p(
      text(
        "Every unit of work in the quarter, with an owner, an estimate and a cycle. This is the board we stand up in the Monday sync.",
      ),
    ),
  ],
  bugs: [
    p(text("Bugs reported by the team and by customers, triaged by severity. Anything High or Critical gets a ticket and a fix within the week.")),
  ],
  crm: [
    p(text("The customers we talk to, what they pay, and who owns the relationship. Kept deliberately small — real relationships, not a lead list.")),
  ],
  content: [
    p(text("What we publish and when. Drafts live here until they ship; the Calendar view is the editorial calendar.")),
  ],
  team: [
    p(text("Who we are, what we own and where we are. Update your own row when you join.")),
  ],
  requests: [
    p(text("Feature requests from customers and from the community, with votes. This is the top of our roadmap funnel.")),
  ],
};
