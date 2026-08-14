# Manual npm release checklist

This is the authoritative release procedure for the independently versioned
`@silksong-git/core` and `@silksong-git/cli` packages. History and Repo Session
remain private workspace implementation packages bundled into the CLI and must
never be selected for publication.

## Release policy

- Core and CLI start at `0.1.0` and advance independently.
- Core `0.1.x` changes are backward compatible. A breaking Core API change uses
  the next `0.x` minor.
- Public Core removals are documented, marked `@deprecated` first, and retained
  until the next Core minor. Urgent security or correctness concerns may
  require immediate removal.
- Annotated package tags are `core-v<version>` and `cli-v<version>`. Push each
  selected tag before publishing its package. Once pushed, a package tag is
  immutable: never move, delete, or reuse it.
- Manual public releases use the `latest` npm dist-tag.
- A bad published version is normally deprecated and replaced by a patch. It is
  not normally unpublished.

## Prepare and dry-run

1. Choose the package or packages being released. Set each selected manifest's
   version independently and update only its own changelog.
2. If CLI changes its Core requirement, set a real npm semver range. Confirm the
   range accepts the current Core version with `pnpm check:release-packages`.
3. Run the required repository checks serially:

   ```sh
   pnpm validate:agent
   ```

   Release verification builds and dry-packs only Core and CLI, checks the exact
   package contents and packed manifests, and installs the local tarballs with
   npm and pnpm in separate non-workspace directories. It directly executes the
   installed CLI's `--help` and `--version`, initializes a real repository, and
   probes authenticated watcher HTTP.

4. Inspect each selected tarball without publishing:

   ```sh
   pnpm --filter @silksong-git/core pack --pack-destination /tmp/silksong-release
   pnpm --filter @silksong-git/cli pack --pack-destination /tmp/silksong-release
   npm publish --dry-run /tmp/silksong-release/silksong-git-core-<version>.tgz
   npm publish --dry-run /tmp/silksong-release/silksong-git-cli-<version>.tgz
   ```

5. Confirm the selected versions do not already exist and that the registry is
   exactly `https://registry.npmjs.org/`. Confirm the operator is intentionally
   authenticated before proceeding; account administration is separate from
   this repository procedure.
6. Confirm there are no unrelated working-tree changes. Commit the selected
   manifests, changelogs, and associated release changes, then push that release
   commit to the canonical repository. Before tagging, confirm the working tree
   is clean and the release commit is present on the canonical remote. Do not
   tag an uncommitted or unpushed state.
7. Create an annotated tag for each selected package at that release commit,
   verify every tag resolves to the intended commit, and push the tags before
   publishing:

   ```sh
   git tag -a core-v<version> -m "@silksong-git/core <version>"
   git tag -a cli-v<version> -m "@silksong-git/cli <version>"
   git push origin core-v<version> cli-v<version>
   ```

   Create and push only the tags for packages selected in this release. Once a
   tag has been pushed, never move, delete, or reuse it.

8. From the clean tagged release commit, rebuild the selected tarballs and
   retain exactly those artifacts for publication. Confirm each tarball's
   manifest version matches its tag. Do not publish a tarball built from another
   commit or from a dirty working tree.

## Publish and verify

1. Publish the retained Core tarball built from its pushed tagged commit first:

   ```sh
   npm publish /tmp/silksong-release/silksong-git-core-<version>.tgz --access public --tag latest --registry https://registry.npmjs.org/
   ```

2. Before publishing a CLI version that requires that Core release, verify the
   required Core version is visible from the registry. Then publish the retained
   CLI tarball built from its pushed tagged commit:

   ```sh
   npm view @silksong-git/core@<version> version --registry https://registry.npmjs.org/
   npm publish /tmp/silksong-release/silksong-git-cli-<version>.tgz --access public --tag latest --registry https://registry.npmjs.org/
   ```

3. In fresh directories outside this workspace, install the registry packages
   once with npm and once with pnpm. Directly execute `silksong-git --help` and
   `silksong-git --version` for each installation and confirm the reported CLI
   version.
4. Record the immutable package name, version, registry URL, release commit, and
   already-pushed package tag in the release notes.
5. If publication fails without requiring any artifact or code change, diagnose
   the failure and retry only the same tagged tarball when safe. If any code,
   metadata, or artifact must change, do not move or reuse the pushed tag. Start
   a new release with the next package version, a new release commit, and a new
   package tag.
