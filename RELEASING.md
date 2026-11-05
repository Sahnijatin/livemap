# Releasing

How to publish a new version of `livemap` to npm. Run these on your own machine, from a clean checkout of `main`.

## Before you publish

1. Make sure CI is green on `main`.
2. Set the version in `package.json` (for example `0.2.0`), and add a matching entry at the top of `CHANGELOG.md`.
3. Build and check the package:

   ```sh
   npm ci
   npm --prefix ui ci
   npm run build
   npm run licenses:check
   npm run smoke
   npm publish --dry-run
   ```

   `npm publish --dry-run` lists every file that will ship. Check that it holds only `package.json`, `README.md`, `LICENSE` and `dist/`.

## Publish

```sh
npm login            # once per machine; opens the browser
npm publish
```

Then tag the release:

```sh
git tag v0.2.0
git push origin v0.2.0
```

## After publishing

- Check the package page: https://www.npmjs.com/package/livemap
- Try it in an empty folder: `npx livemap@latest --version` (prints the version)
- A broken release can be deprecated with `npm deprecate livemap@<version> "<reason>"`. Unpublishing is only possible within 72 hours and is best avoided.
