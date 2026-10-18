# git-fs-s3 documentation

The source for the [git-fs-s3 docs site](https://nandan-varma.github.io/git-fs-s3/) —
an Astro + Starlight build of the package's guides and API reference. It is
published from `main` by GitHub Pages; the package's own `README.md` is
separate and serves as the npm page.

## Content

- `src/content/docs/` — every page, one `.md`/`.mdx` file per route. The
  directory structure matches the URL: `guides/object-store.mdx` is
  `/git-fs-s3/guides/object-store/`.
- `astro.config.mjs` — the site config, including the sidebar. A page that
  isn't listed in `sidebar` still builds; it just won't be linked from the nav.
- `src/components/` — the Astro components pages import (`ApiSignature`,
  `PackageExports`, `RuntimeSupport`).
- `src/styles/custom.css` — site styles.

The sidebar is a plain array of `{ label, slug }` items, grouped by section.
Add a page by creating the file and referencing its slug there.

## Commands

Run these from `docs/`:

| Command | Action |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm run dev` | Start the dev server at `localhost:4321/git-fs-s3/`. |
| `npm run build` | Build the production site to `./dist/`. |
| `npm run preview` | Serve the built site locally, before deploying. |
| `npm run astro -- --help` | Run the Astro CLI directly. |

Run `npm run build` before opening a pull request that adds or renames pages
— it's the only check that builds the whole content collection and the sidebar
together.

`AGENTS.md` covers running the dev server in an agent environment; the
[Astro documentation](https://docs.astro.build) covers the framework itself.
