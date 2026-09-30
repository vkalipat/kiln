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

Keep commands consistent with `docs/user-manual.md`. Readiness statements describe
the release and available features; this static site never reads a visitor's local
configuration and does not imply live service health. Keep credentials, private
workspace paths, and run records outside this directory.
