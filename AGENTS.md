# Repository Guidelines

## Project Structure & Module Organization

Taomni targets Windows, macOS, and Linux desktops using Tauri 2, React 19, TypeScript, and Rust. `src/` contains components/layouts, hooks/types, Zustand stores, IPC/utilities (`lib/`), and browser shims (`stubs/`). Backend code is in `src-tauri/src/`; integration tests share `src-tauri/tests/integration/main.rs`. Desktop assets live in `src-tauri/icons/` and `src-tauri/resources/`; browser bridges in `vite-plugins/`.

## Build, Test, and Development Commands

Native builds require Rust 1.94+, `protoc`, complete Perl, Tauri system dependencies, and Bash for hooks. Consult `.github/workflows/release.yml` for platform setup.

- `pnpm install`: install dependencies.
- `pnpm dev`: browser preview with stubs, port `5000`.
- `pnpm tauri dev`: desktop application, Vite port `1980`.
- `pnpm build`: TypeScript checks and frontend build into `dist/`.
- `pnpm test [file]`: all or selected Vitest tests.
- `pnpm tauri build`: package the current platform under `src-tauri/target/`.

From `src-tauri/`, use `cargo test --lib` for iteration, `cargo test --test integration` for integration, or `cargo test` for the full suite. Before direct Cargo commands on macOS, run `bash scripts/bundle-krb5-macos.sh stage` from repository root.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, and no unused locals/parameters. Components use `PascalCase`, hooks `use*`, stores `*Store.ts`; Rust uses `snake_case`. Respect existing feature gates and platform dependencies. Format only edited Rust files with `rustfmt --edition 2024 <files>`; never run project-wide `cargo fmt` or add a toolchain pin without explicit request.

## Testing Guidelines

Colocate `*.test.ts`/`*.test.tsx` tests using Vitest, Testing Library, and jsdom; setup is `src/test/setup.ts`. Rust uses inline `#[test]`/`#[tokio::test]` and the unified integration suite. Add focused behavior/regression coverage.

Use `.agents/skills/qa-ui-auto/` for `qa-ui-auto-tests/cases/TC-*.testcase.yaml`; keep `covers`, controls, and `qa-ui-auto-tests/feature-list.md` aligned. CI runs `python -m qa_ui_auto.audit --gate`. Record skipped live-service cases explicitly.

Preserve three-platform code compatibility. Plan native verification for all three; completing current-platform verification suffices for the current delivery, with others recorded as unverified. Browser stubs cannot prove native behavior.

## Design Workflows

Project skills `feature-design` and `issue-design` live under `.agents/skills/`. Both accept `prompt`, `design`, or natural language. Write designs to `docs-feature/` and `docs-issue/`, respectively, linking acceptance criteria, implementation tasks, tests, and evidence.

## Commit & Pull Request Guidelines

Follow scoped conventional commits, e.g. `fix(code-workspace): ...` or `feat(settings): ...`. PRs should describe changes, affected areas, linked issues, verification, and screenshots/recordings for visible UI changes.

## Security & Configuration Tips

Keep credentials, logs, `qa-ui-auto-report/`, `dist/`, and `target/` uncommitted. Use isolated test data. Maintain application versions in root `package.json`; `tauri.conf.json` references it.
