# Validation

`CLAUDE.md` is a symlink to this file. Edit this one.

Run validations from the repository root after making changes.

## Required checks

Run the following before considering a change complete:

```sh
npm run check
npm run typecheck
npm test
```

- `npm run check` runs Biome formatting, import organization, and recommended lint rules across `src/**/*.ts`, `vitest.config.ts`, `package.json`, and `biome.json`.
- `npm run typecheck` runs TypeScript with `--noEmit` across every file, tests included.
- `npm test` runs the Vitest suite (`vitest run`) directly against the TypeScript sources. All tests must pass.
- `npm run test:coverage` runs the same suite with V8 coverage; the text summary goes to stdout and `lcov`/HTML reports land in `coverage/`. Thresholds are enforced (85% statements/functions/lines, 80% branches), so this fails on a coverage drop even when every test passes.

## Formatting

Use this command to apply the repository's formatting rules:

```sh
npm run format
```

Use this command to verify formatting without changing files:

```sh
npm run format:check
```

Do not use `--write` as a validation substitute; formatting changes should be reviewed before validation is rerun.

## Build validation

Run the production compilation when changing compiler settings, module boundaries, build output, or packaging. It uses `tsconfig.build.json`, which excludes tests and `src/testing/`:

```sh
npm run build
```

## Runtime smoke test

The daemon requires a running herdr socket. When that integration is available, run:

```sh
npm run dev
```

Confirm that the process starts, renders its status row to stdout, and exits cleanly on `SIGINT` or `SIGTERM`. If herdr is unavailable, report the runtime smoke test as environment-blocked; still run the required static checks and test suite.
