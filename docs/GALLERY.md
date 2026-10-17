# The gallery

Every screen in Noema, photographed in the seeded demo workspace.

The images are **generated, not hand-taken**:
[`scripts/screenshots.mjs`](../scripts/screenshots.mjs) drives the running app in
a real browser, and each caption lives beside the selectors that take the
picture — so a surface that changes takes its screenshot with it, and this page
is rebuilt from the same source of truth.

```bash
npm run seed                          # a demo workspace worth photographing
npm start -- --port 3200              # the app
npm run screenshots                   # → docs/screenshots/*.png + report.json
npm run screenshots -- --only db-     # just the database views
npm run screenshots -- --gallery      # rewrite the list below from report.json
npm run screenshots -- --explore /w/demo-workspace   # dump a page's affordances
```

Two shots (`01-landing`, `02-login`) are captured **signed out**, in their own
browser context: `/` and `/login` both redirect to the workspace once a session
exists, and a gallery that logged in first captioned two images "landing page"
and "sign in" while both showed the workspace home.

## Reading a screenshot

- Every image is 1440×900 at device scale 1, except `43-mobile-editor`, which is
  390×844 — the same page on a phone.
- `01-landing` and `33-public-page` are full-page captures; the rest are the
  viewport, because the point is the chrome as much as the content.
- `04-home-dark` is the only dark shot. A theme is a *preference*, so the harness
  sets it per shot — otherwise the dark cookie would ride along and every later
  screenshot would come out dark.
- `report.json` is the machine-readable version of this page: name, caption,
  route, page title and first heading for each shot.

The eight the [README](../README.md) leads with are the ones a reader needs
first. The full set is below, so nothing in the documentation is described but
unseen.

<!-- gallery:start -->

### 01-landing

The public landing page

![The public landing page](./screenshots/01-landing.png)

### 02-login

Sign in — email, password, remember-me

![Sign in — email, password, remember-me](./screenshots/02-login.png)

### 03-home

Workspace home — quick starts and the template gallery

![Workspace home — quick starts and the template gallery](./screenshots/03-home.png)

### 04-home-dark

The same home in dark mode

![The same home in dark mode](./screenshots/04-home-dark.png)

### 05-sidebar

Sidebar — favourites, pages, teamspaces, projects, tickets

![Sidebar — favourites, pages, teamspaces, projects, tickets](./screenshots/05-sidebar.png)

### 06-editor

The block editor — headings, callouts, toggles, code, tables, backlinks

![The block editor — headings, callouts, toggles, code, tables, backlinks](./screenshots/06-editor.png)

### 07-slash-menu

The slash menu

![The slash menu](./screenshots/07-slash-menu.png)

### 08-command-palette

Command palette (Ctrl/⌘ K)

![Command palette (Ctrl/⌘ K)](./screenshots/08-command-palette.png)

### 09-quick-find

Quick find (Ctrl/⌘ P)

![Quick find (Ctrl/⌘ P)](./screenshots/09-quick-find.png)

### 10-shortcuts

Keyboard shortcuts — the same dialog the desktop menu opens

![Keyboard shortcuts — the same dialog the desktop menu opens](./screenshots/10-shortcuts.png)

### 11-db-table

Database — table view with relations, a rollup and a percent property

![Database — table view with relations, a rollup and a percent property](./screenshots/11-db-table.png)

### 12-db-board

Database — board view grouped by status

![Database — board view grouped by status](./screenshots/12-db-board.png)

### 13-db-timeline

Database — timeline view

![Database — timeline view](./screenshots/13-db-timeline.png)

### 14-db-chart

Database — chart view

![Database — chart view](./screenshots/14-db-chart.png)

### 15-db-list

Database — list view

![Database — list view](./screenshots/15-db-list.png)

### 16-db-calendar

Database — calendar view

![Database — calendar view](./screenshots/16-db-calendar.png)

### 17-db-gallery

Database — gallery view with cover images

![Database — gallery view with cover images](./screenshots/17-db-gallery.png)

### 18-row-peek

A row, opened in the side peek

![A row, opened in the side peek](./screenshots/18-row-peek.png)

### 19-tickets-list

Tickets — list view with filters and saved views

![Tickets — list view with filters and saved views](./screenshots/19-tickets-list.png)

### 20-tickets-board

Tickets — board view

![Tickets — board view](./screenshots/20-tickets-board.png)

### 21-tickets-timeline

Tickets — timeline view

![Tickets — timeline view](./screenshots/21-tickets-timeline.png)

### 22-ticket-drawer

A ticket — description, activity, comments and linked work

![A ticket — description, activity, comments and linked work](./screenshots/22-ticket-drawer.png)

### 23-cycles

Cycles — burndown, scope and progress

![Cycles — burndown, scope and progress](./screenshots/23-cycles.png)

### 24-projects

Projects — progress, owners and target dates

![Projects — progress, owners and target dates](./screenshots/24-projects.png)

### 25-project

A project — milestones and linked tickets

![A project — milestones and linked tickets](./screenshots/25-project.png)

### 26-library

Library — every database in the workspace

![Library — every database in the workspace](./screenshots/26-library.png)

### 27-search

Search — full text, scoped to what you can see

![Search — full text, scoped to what you can see](./screenshots/27-search.png)

### 28-inbox

Inbox — mentions, comments and updates

![Inbox — mentions, comments and updates](./screenshots/28-inbox.png)

### 29-chat

Chat — a workspace conversation, with the notes it cites

![Chat — a workspace conversation, with the notes it cites](./screenshots/29-chat.png)

### 30-comments

Comments and page discussion

![Comments and page discussion](./screenshots/30-comments.png)

### 31-versions

Version history — every save, restorable

![Version history — every save, restorable](./screenshots/31-versions.png)

### 32-share

Share — public link, permissions and export

![Share — public link, permissions and export](./screenshots/32-share.png)

### 33-public-page

A published page, as a visitor sees it

![A published page, as a visitor sees it](./screenshots/33-public-page.png)

### 34-templates

Templates — saved templates and the built-in library

![Templates — saved templates and the built-in library](./screenshots/34-templates.png)

### 35-roadmap

Roadmap — the workspace-level timeline

![Roadmap — the workspace-level timeline](./screenshots/35-roadmap.png)

### 36-audit

Audit log — who changed what

![Audit log — who changed what](./screenshots/36-audit.png)

### 37-trash

Trash — restore, or delete for good

![Trash — restore, or delete for good](./screenshots/37-trash.png)

### 38-settings

Settings — general, members, roles and invites

![Settings — general, members, roles and invites](./screenshots/38-settings.png)

### 39-settings-tokens

Settings — API tokens

![Settings — API tokens](./screenshots/39-settings-tokens.png)

### 40-settings-data

Settings — data, export and privacy

![Settings — data, export and privacy](./screenshots/40-settings-data.png)

### 41-settings-prompts

Settings — the prompt library

![Settings — the prompt library](./screenshots/41-settings-prompts.png)

### 42-settings-notifications

Settings — notification preferences

![Settings — notification preferences](./screenshots/42-settings-notifications.png)

### 43-mobile-editor

The same page on a phone viewport

![The same page on a phone viewport](./screenshots/43-mobile-editor.png)

### 44-about

About — version, credits and licence, from Help → About

![About — version, credits and licence, from Help → About](./screenshots/44-about.png)

<!-- gallery:end -->
