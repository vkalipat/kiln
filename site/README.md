# Kiln documentation site

Static HTML, CSS and JavaScript. No build step, third-party scripts, or runtime dependencies.

Preview from the repository root:

```sh
python3 -m http.server 8094 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:8094. Check desktop and mobile layouts, section links,
the Contents menu (including Escape), and command copying. A denied clipboard
permission selects the command for manual copying.

`.github/workflows/docs.yml` publishes only this directory to GitHub Pages when
`site/` changes on `main`. Configure the repository's Pages source as GitHub Actions.
Public URL: https://vkalipat.github.io/kiln/.

Keep commands consistent with `docs/user-manual.md`. Use descriptive headings,
a short explanation, and actionable steps. Keep operational limits together in
Usage notes; keep setup prerequisites beside their commands. Avoid promotional
copy, development-status callouts, and redundant heading labels. Keep credentials,
private workspace paths, and run records outside this directory.
