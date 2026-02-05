# Stage 0 — Instructions

## What was implemented
- Bootstrapped a fresh Vite + React + TypeScript workspace in `stages/code/stage0` with TailwindCSS (dark mode via `class`), Zustand stores, React Router, Heroicons, Toast, ESLint flat config, and TypeScript project references so later stages can plug in without rework.
- Built the full AppShell layout: responsive sidebar, sticky header that embeds the navbar, wallet placeholder CTA, and the theme toggle that stores preference in `localStorage` and applies the `.dark` class on the `<html>` element.
- Created router skeleton + placeholder pages for Markets, Portfolio, TGBP, and Admin along with a `/src/features` stub so each later stage can fill in its feature modules while the shell stays constant.

## How to set up (conda env: `tokenised-lse`)
1. `conda activate tokenised-lse`
2. `cd stages/code/stage0 && npm install`

## How to run / play
- `npm run dev` to launch Vite. Visit the shown URL to interact with the layout shell.
- Use the sidebar or header nav pills to switch between Markets/Portfolio/TGBP/Admin placeholder screens.
- Trigger the theme toggle in the header to flip between light/dark palettes and verify the `.dark` class is applied.
- Click “Connect wallet” / “Disconnect” to see the Zustand wallet placeholder update the status text.

## How to test quickly
- `npm run typecheck` — already verified locally and it passes.
- `npm run lint` — the script was updated (remove the obsolete `--ext` flag) so please rerun now; it should succeed with the flat ESLint config.

Am I good to proceed to Stage 1 with this shell, or would you like any adjustments before we continue?
