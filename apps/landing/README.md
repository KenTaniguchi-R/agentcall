# AgentCall landing page

This directory is the complete GitHub Pages publishing root. It is deliberately
separate from `docs/site`, which Mintlify owns.

The page has no build step or dependencies. Edit `index.html`, open it directly
in a browser to preview it, and merge the change into `main`. Changes under this
directory trigger `.github/workflows/pages.yml` and publish automatically.

The hero image lives at `assets/hero-placeholder.svg`. Replace it in place, or
update the relative `src` in `index.html`. Prefer SVG, WebP, or AVIF and include
explicit width and height attributes so the page does not jump while it loads.

Repository administrators must select **GitHub Actions** as the Pages source in
the repository settings before the first deployment.
