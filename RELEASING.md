# Releasing `benchrouter`

The workflow `.github/workflows/publish.yml` publishes the `benchrouter` package with npm trusted
publishing (GitHub Actions OIDC). No npm token or one-time password is used, and npm records a
provenance statement for each version.

## Release a version

1. Change `version` in `package.json` and `package-lock.json` in the pull request. npm refuses a
   version that it already has.
2. Merge the pull request to `main`.
3. Pull `main`, then tag the merge commit and push the tag:

   ```sh
   git tag -a v0.2.45 -m v0.2.45 <merge-sha>
   git push origin v0.2.45
   ```

The tag starts the workflow. It runs `npm run check`, then publishes. The publish fails when the
tag is not `v<version>` for the `package.json` version, or when the tagged commit is not on
`main`. To publish again after a failure, open the workflow in GitHub Actions, select **Run
workflow**, and select the tag (not a branch) in **Use workflow from**. A run started from a
branch only checks the package.

npm can take several minutes to show a new version after the workflow passes.

## One-time setup on npmjs.com

Do this once, immediately before the first workflow release. A new trusted publisher expires if
it has no successful publish within 2 days. After it expires, you cannot use or edit it: delete
it, create a new one, and publish within 2 days.

1. Sign in to npmjs.com as an owner of `benchrouter`.
2. Open https://www.npmjs.com/package/benchrouter/access (package **Settings**).
3. In **Trusted Publisher**, select **GitHub Actions**. Enter these values:
   - Organization or user: `BenchRouter`
   - Repository: `cli`
   - Workflow filename: `publish.yml`
   - Environment name: leave empty
   - Allowed actions: enable `npm publish`. A new trusted publisher allows only
     `npm stage publish` by default, and then the workflow's `npm publish` fails.
4. Save.
5. After the first workflow release passes, delete the repository secret `NPM_TOKEN` in
   https://github.com/BenchRouter/cli/settings/secrets/actions. The workflow no longer reads it.
6. After the first workflow release passes, mark the old scoped package deprecated. Trusted
   publishing cannot run this command, so run it signed in as an owner of `@benchrouter/cli`:

   ```sh
   npm deprecate @benchrouter/cli "Moved to benchrouter. Run: npx --yes benchrouter@latest"
   ```
7. Optional: in **Publishing access**, select **Require two-factor authentication and disallow
   tokens**, then select **Update Package Settings**. Trusted publishing continues to work. A
   publish from a laptop with a token then stops working.

## Limits

- The publish job runs on a GitHub-hosted runner (`ubuntu-24.04`). npm trusted publishing does
  not support self-hosted runners.
- Trusted publishing needs npm 11.5.1 or later and Node 22.14 or later. The workflow installs
  npm 12.0.2 on Node 24.15.0.
- `repository.url` in `package.json` must stay `git+https://github.com/BenchRouter/cli.git`, or
  npm refuses the publish.
