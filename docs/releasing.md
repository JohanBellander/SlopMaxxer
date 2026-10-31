# Publishing SlopMaxxer

The package runs directly on Node.js 20+; there is no build step.
The `files` allowlist ships `bin/`, `src/`, and `public/`, plus npm's automatic metadata and README.

1. Run `npm test` and `npm run test:package`.
   The latter packs and installs the artifact in a temporary directory, checks the installed
   executable through npm exec, and checks the demo dashboard and API without reading real accounts.
2. Check the version in `package.json`. Use a new version for each release.
3. Run `npm publish --dry-run` and inspect the included files.
4. Log into the intended npm publisher account with `npm login`, then verify with `npm whoami`.
5. For the first release, check availability with `npm view slopmaxxer`.
   An E404 suggests the name is unused; publication is the final availability check.
6. When authorized to release, run `npm publish --access public` and complete npm's authentication prompts.
7. Verify `npx --yes slopmaxxer@0.1.0 --version` from outside this checkout (substitute the released version),
   then try `npx slopmaxxer@latest --demo`.
8. Remove the pre-release status notice in README.md after the first successful publication.

Never store npm tokens in the repository. Authentication is managed by npm on the publishing machine.
