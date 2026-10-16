# alpha.6: Projects navigator and the navy theme

Status: ready to build · Branch: `feat/projects-navigator` off `main` · Ships as
`2.0.0-alpha.6`, together with the Phase 4b work. alpha.5 is never published.

Goal: two changes.
- **Projects tab:** it becomes a navigator that stays usable with 87 registered repos, most
  of them inactive. A list on the left, with the selected project in detail on the right.
- **Theme:** the console and the widget move to the navy/blue scheme from Robe's concept,
  with a matching light variant.

Source: a GPT-generated concept Robe shared on 2026-10-16 ("Sereno project navigator,
reimagined", kept locally, not in the repo). Its rules and data still come from Sereno's
invariants and `docs/design/console/README.md`.

## Decisions (Robe, 2026-10-16)

- Adopt the concept's colour scheme for the **console and the widget**, with a **matching
  light variant** that follows the system setting.
- Hold the release: Phase 4b and this work ship together as alpha.6.
- Adopt the Projects layout with these changes:
  - The only action is "Review in terminal". No "Open session", "View session" or "Run in a
    session".
  - "Copy /sereno:brief", not `/brief`.
  - No pagination.
  - A plain branch list, not a tree.
  - Activity comes from data we already have.
  - Pinning is new.
  - "Manage projects" opens hide/unhide.
  - No "⋯" menu.

## Architect decisions

- **Theme tokens only.** Every colour lives in the `:root` tokens of `console.css` and the
  widget's `app.css`. The palette changes there, and no component hard-codes a colour.
  Starting point (dark), sampled from the concept and to be tuned for contrast:

  | Token | Dark |
  |---|---|
  | `--bg` | `#0B1626` |
  | `--panel` | `#0F1E33` |
  | `--panel2` | `#13263F` |
  | `--line` | `#1F3550` |
  | `--grid` | `#172B44` |
  | `--text` | `#E6EDF5` |
  | `--muted` | `#9FB0C3` |
  | `--quiet` | `#7C8EA3` |
  | `--accent` | `#2F8CEB` (new: selection, active filter, focus ring) |
  | `--accentbg` | `#14345A` (new) |
  | `--selected` | `#163150` |

  Amber (`--amber`, `--amberbg`) keeps its meaning: "needs you" or a pending decision, and
  nothing else. The `--src-*` role colours are re-tuned only as far as their contrast on the
  new background needs.
  The light variant uses the same hues: a white or very light blue-grey background, a darker
  `--accent` for AA, and amber unchanged in meaning.
- **Contrast is tested.** A test computes WCAG contrast ratios from the token values.
  `--text` and `--muted` on `--bg`, `--panel` and `--panel2` must reach ≥ 4.5:1, and
  `--quiet` ≥ 3:1 (it is used only for secondary text 11 px and up). It checks both themes
  and both stylesheets.
- **Pinning** is a `pinned` boolean on each `projects.json` entry, next to `hidden`. It is
  written atomically like `hidden`. The action is `POST /api/projects/<id>/pin`
  (`{pinned: bool}`), behind the same guard as hide: token, Host/Origin, body cap. Pinning
  is Sereno's own config, not an action on a repo.
- **Activity** per project uses only data already held, kept in memory and never written
  by this feature:
  - recent commits from the existing poller's git calls (subject capped at 120 chars, control
    chars stripped, at most 10; `git log` subjects are repo data, not prompts);
  - brief updates (`generated_at`);
  - pipeline events from the 4b task views.
- **"Active"** means the project has a live session, a commit in the last 14 days, or a
  pipeline task that isn't expired. Inactive projects fold into a collapsed group in the list.

## Layout

- Header:
  - title, then a summary: `N projects · N with blockers · N stale · N decisions`;
  - top right: the attention state ("Nothing needs you", or amber), the sync time, and
    "Manage projects", which opens the hide/unhide view.
- **Left list:**
  - filter chips All / Active (default) / With blockers, each with a count;
  - a search box over name and path, filtering in the client only;
  - a sort menu (Pinned first, Recent, Name);
  - a **Pinned** group, then **Projects**, then a collapsed **Inactive (N)** group;
  - each row shows the name, a status line (Running / Idle · N branches, or the brief
    freshness), a live-session marker and a pin toggle;
  - one scrolling pane, no pagination; arrow keys move the selection inside the list.
- **Right detail:**
  - header: name, brief state pill, git line (default branch, ↑↓, open PRs, last commit,
    dirty), "Review in terminal" only when a live session exists;
  - a brief card: Now / Next / Blocked with freshness, or "No brief yet" with "Copy
    /sereno:brief". The plugin install commands appear if the plugin isn't detected;
  - a 14-day spend sparkline with its total, labelled `est.`;
  - sub-tabs: **Branches** (a list: name, ahead/behind, brief freshness, last commit),
    **Activity** (newest first, at most 20), **Git & PRs** (open PR count and the default
    branch state, which is all we have);
  - footer: the live session strip (state, updated time) when one exists.
- **Widget:** the theme only. No layout changes.

## Exit criteria (`[alpha6 exit]` in `tools/test.js`)

1. With about 90 registered projects, the Projects tab shows Active by default, and
   inactive projects sit in a collapsed group.
2. Pin and unpin persist in `projects.json`. Without a valid token, the request is refused.
3. Activity holds no text other than capped commit subjects, and nothing from it is
   written to disk.
4. The only action control in the detail pane is "Review in terminal", and only with a
   live session.
5. The contrast test passes for both themes and both stylesheets.
6. Amber appears only in "needs you" and decision contexts, across console and widget.

## Steps

- **T1, theme:** tokens in `console.css` and `app.css`, dark and light; `--accent` and
  `--accentbg`; components switch from hard-coded selection colours to the tokens; the
  contrast test; the existing amber-rule tests still pass.
- **N1, API:** `pinned` with the pin action; per-project `active`, `lastActivityAt`,
  `activity[]` (`{ at, kind, text? }`, where `text` is only a commit subject) and
  `blockers` (the brief has a non-empty Blocked line); header counts. Allowlist tests.
- **N2, renderer:** the Projects navigator as above; Manage projects (hide/unhide); tests
  covering the render helpers, filters, search, groups, pin, escaping and keyboard.
- **R, release prep:**
  - version `2.0.0-alpha.6`;
  - README and `CLAUDE.md` (roadmap, test count);
  - `docs/design/console/README.md`, noting the theme change;
  - the red team on the branch;
  - after merging: the installer, Robe's look, release notes.

## Out of scope

A real branch topology graph, PR details beyond the count, and search across repo contents.
