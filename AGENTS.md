# Repository Guidelines

## Project Structure & Module Organization

Taomni is a Tauri 2 desktop app with a React 19/TypeScript frontend and Rust backend. Frontend code lives in `src/`: `components/` for UI, `layouts/` for app shells, `lib/` for IPC and utilities, `stores/` for Zustand state, `stubs/` for browser-only Tauri shims, and `test/` for Vitest setup. Backend code lives in `src-tauri/src/`; Rust integration tests are in `src-tauri/tests/`. End-to-end UI artifacts are under `qa-ui-auto-tests/`, with YAML cases in `qa-ui-auto-tests/cases/`. Build output goes to `dist/` and Tauri artifacts to `src-tauri/target/`.

## Build, Test, and Development Commands

- `pnpm install`: install Node dependencies.
- `pnpm dev`: run the Vite frontend on port `5000` with `src/stubs/`.
- `pnpm tauri dev`: run the full desktop app; Tauri uses Vite on port `1980`.
- `pnpm build`: run `tsc -b` and build frontend assets into `dist/`.
- `pnpm test`: run frontend/unit tests with Vitest and jsdom.
- `pnpm tauri build`: build and package the desktop app.
- `cd src-tauri && cargo test --lib`: day-to-day Rust unit tests (fastest; no integration binary).
- `cd src-tauri && cargo test --test integration`: unified integration suite (one linked binary).
- `cd src-tauri && cargo test`: full suite (lib + integration + relevant bins).

## Coding Style & Naming Conventions

Use TypeScript strict mode and keep code free of unused locals and parameters. Follow existing style: two-space indentation in TS/TSX, double quotes, React components in `PascalCase`, hooks prefixed with `use`, stores named `*Store.ts`, and tests named `*.test.ts` or `*.test.tsx`. Rust code should follow `rustfmt` defaults with edition 2024, snake_case modules/functions, and feature gates already defined in `src-tauri/Cargo.toml`. Do not add a repository-level Rust toolchain pin unless explicitly requested. Do not run project-wide `cargo fmt`; if Rust formatting is necessary, run `rustfmt --edition 2024 <changed .rs files>` only on files you edited.

## Testing Guidelines

Vitest tests colocate with source files and use `describe`/`it`. Add focused tests for new utilities, stores, and UI behavior. Rust tests use inline `#[test]` modules or files in `src-tauri/tests/`; async tests use `#[tokio::test]`. For UI workflow coverage, add or update `qa-ui-auto-tests/cases/TC-...testcase.yaml` and keep feature references aligned with `qa-ui-auto-tests/feature-list.md`.

## Commit & Pull Request Guidelines

Recent history mostly uses conventional commits such as `fix(agent): ...`, `feat(agent): ...`, and `feat: ...`; keep messages short, imperative, and scoped when useful. PRs should include a concise summary, affected areas, linked issues if any, tests run, and screenshots or recordings for visible UI changes.

## Security & Configuration Tips

Do not commit secrets, local credentials, generated logs, `qa-ui-auto-report/`, `dist/`, or `src-tauri/target/`. Keep app version changes centered on root `package.json`; `tauri.conf.json` reads that version for packaging.
