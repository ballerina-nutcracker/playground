---
name: playground-create-pr
description: Create a pull request in the Ballerina Playground repository (ballerina-nutcracker/playground), including a screen recording for UI changes. Use whenever asked to open or create a PR in this repository.
---

# Create a Playground pull request

## Prerequisites

Use Git, Bun, and an authenticated GitHub CLI (`gh`). For UI recordings, install Playwright's Chromium browser (`bunx playwright install chromium`) and have FFmpeg and `jq` on `PATH`. The stacked PR workflow additionally requires the `gh stack` extension and its companion `gh-stack` skill; neither is needed for an ordinary PR. If fixups need folding and the external `fix-up-target` skill is unavailable, ask the contributor to fold them and recheck the branch before continuing.

## Check readiness

First identify the intended base, head and the commits the PR adds, and read the full diff about to be pushed. On a stack, review only the commits added beyond the parent branch.

- Check whether the branch is up to date with its base.
- Inspect committed Markdown files for unwanted scratch or design documents, including `spec.md`, `research.md`, `rca.md`, `progress.md`, `plan.md`, `deferred.md` and `design-ledger.md`. Do not assume all Markdown is unwanted: intended project documentation belongs in the PR.
- Check for fixup, squash or amend commits that should be folded into their targets rather than presented as separate commits, including `fixup!`, `squash!` and `amend!` subjects.
- Before running checks or recording, inspect staged and unstaged changes and untracked files that could affect their results (start with `git status --short`). Use a checkout of the intended head with no local changes affecting the checks or the app build. Unrelated draft files and the local demo spec may remain. Preserve local edits; if you cannot verify or record the intended head, report the affected checks as unverified or the demo as blocked. Do not present results from a different tree as evidence for the PR.
- Run the checks CI runs (`.github/workflows/ci.yml`) from the repository root: `bun format`, `bun lint`, `bun run test`, `bun run build` and `bun run test:e2e`. If examples or runtime output changed, follow `AGENTS.md` for the example golden files. Report checks that fail or cannot be run; do not treat them as passing.

If there are any concerns, present them and ask the user what to do before pushing or creating the PR. Do not remove files, rewrite history, fix code or bypass failed checks on your own. After an approved change, recheck readiness and rerun affected checks. Use the `fix-up-target` skill for approved fixup handling and squashing. Preserve a local copy of any scratch document before removing it from commits; it may inform the PR description.

## Record a demo for UI changes

A PR that changes anything a user can see or interact with in `apps/web` (layout, styling, components, flows, messages, agent view behaviour) must include a screen recording in its description. Skip this only for changes with no visible effect, and say so under For human review.

Recording uses Playwright against a fresh production build of the intended head, as checked above. The tools are in `record/` next to this file; `$SKILL` below is this skill's directory.

1. Write a demo spec in `.pr-media/demos/<name>.spec.ts` (git-ignored). Show the change from a user's point of view: start from a realistic state, perform the interaction at a readable pace, and end on the result. The demo must exercise the exact behaviour the PR adds or fixes: for a bug fix, perform the action that triggered the bug (for example, edit the signature that used to lose the chat) and show that the result is now correct. Showing nearby features is not enough. Keep it short (ideally under 30 seconds of activity). For a bug fix, an optional second demo of the same steps on the base branch makes a useful before/after.

   ```ts
   import { expect, test } from "@playwright/test";
   import { beat, connectOpenRouter, PlaygroundPage } from "../../.agents/skills/playground-create-pr/record/helpers";

   test("agent view: <what this shows>", async ({ page }) => {
    const playground = new PlaygroundPage(page);
    await playground.open();
    await playground.openBalBot();
    await connectOpenRouter(page, "MiniMax: MiniMax M3.1 Flash");
    // ...interact; use beat(page) to pause where a viewer needs to read...
    await expect(/* the visible result */).toBeVisible({ timeout: 120_000 });
    await beat(page, 2_000);
   });
   ```

   `PlaygroundPage` is the e2e page object from `e2e/helpers/playground.ts`; reuse its methods and the locators in `e2e/tests/` rather than inventing new ones.

2. Run it: `bunx playwright test --config "$SKILL/record/playwright.config.ts"`. It builds the web app and serves it on port 4183 (`PR_MEDIA_PORT` overrides it); `PR_MEDIA_SLOWMO` (default 150 ms) slows every action. The video is written to `.pr-media/videos/<test>/video.webm`.

3. Convert it: `"$SKILL/record/convert.sh" <video.webm> .pr-media/out/<name> [--start S] [--end S] [--speed N]`. This writes a GIF for inline display and an MP4 for full quality. Trim the app's loading screen and long idle waits (such as waiting for a model response) with `--start`/`--end` and `--speed`; keep the GIF under 9 MB.

4. Review it before publishing. Extract frames, for example `mkdir -p .pr-media/frames && ffmpeg -i <name>.mp4 -vf fps=1 .pr-media/frames/%03d.png`, and look at them. Confirm that the recording shows the change working, starts and ends in sensible places, and shows no secret, personal data or unrelated local state. If it does not, fix the demo and record again.

5. Publish it: `"$SKILL/record/publish.sh" .pr-media/out/<name>.gif .pr-media/out/<name>.mp4`. This commits the files to the `pr-media` branch of `origin` (it never touches your branch or working tree) and prints Markdown pinned to that commit. `origin` must have one push URL that matches its fetch URL. Put that Markdown under `### Demo` in the Approach section of `pr.md`, followed by a blank line and the one-line caption. This push publishes the media; do it only after the user has agreed to the recording, as part of agreeing to the description.

### Agent view demos and the OpenRouter key

Agent view features need a real model. `connectOpenRouter` reads the key from the `OPENROUTER_API_KEY` environment variable and enters it in the app's API key dialog, whose password field keeps it off screen. The app holds keys only in memory, so every demo connects again.

- If `OPENROUTER_API_KEY` is unset, ask the user to export it in the environment the agent runs in; do not ask them to paste the key into the conversation.
- Never print, echo, log or write the key, and never pass it on a command line or put it in a file. Do not enable protocol debugging, custom snapshots, or other extra diagnostics during a key-bearing recording. Check whether it is set with `[ -n "$OPENROUTER_API_KEY" ]`.
- Prefer an inexpensive model and short prompts. Live model output varies, so assert on structure (a reply appears, a file changes) rather than exact text, and allow generous timeouts.
- If the model call fails, report the failure to the user. Do not mock the provider in a demo: a recording should show the real behaviour.

## Draft and agree on the description

Derive the goals, non-goals, design, blast radius and foot guns from the actual diff and its relevant code context, not just commit messages or design notes. Describe what changed, what intentionally did not, the affected callers and systems, and risks or usage pitfalls a reviewer needs to know.

Write `pr.md` in the project root using the headings in [`pull_request_template.md`](../../../pull_request_template.md). Put linked issues under Purpose; if there is no linked issue, say so rather than guessing. Answer the Security checks from evidence: state when a check was not run. Mark inapplicable sections N/A.

Under Approach, describe the implementation, non-goals, blast radius (including affected public symbols and contracts), failure conditions and known limitations. Add a `### Demo` subsection there for the published recording and a one-line caption; before publication list local GIF and MP4 paths. Under Automation tests, describe changed test behaviour and report actual verification results. Note dependency changes under Approach and `Stacked on #<parent>` under Related PRs, where applicable.

Ask the user to review and refine `pr.md` and the recording. Revise them with their feedback until they agree. Do not push, publish media or create the PR before that agreement. Keep `pr.md` local and uncommitted; preserve any existing user content rather than overwriting it blindly. If the diff changes after approval, update the draft (and the recording, if the change is visible) and obtain agreement again.

## Create the PR

- Base: on a `gh stack` stack, the parent branch; otherwise the intended base branch, usually `main` on `upstream` (`ballerina-nutcracker/playground`).
- Head: push stacked PRs to `upstream`; push ordinary PRs to `origin`. Ordinary PRs may be fork-headed, so their head repository may differ from the target repository. If the required remote is missing, ask the user rather than silently choosing another remote.
- On a `gh stack` stack, follow the `gh-stack` skill and submit with `gh stack submit --auto --remote upstream`; never bare `gh stack submit`, which pushes to `origin`.
- Title: Conventional Commits with the package scope used in this repository's history, for example `fix(web): ...`.
- Description: use the user-approved contents of `pr.md` as the PR body without rewriting them.

## Verify and finish

Verify that the PR uses the intended head repository and branch, targets the intended repository and base, is ready for review unless the user asked for a draft, and that the demo GIF renders in the PR description (`gh pr view --web`, or fetch its URL and check for HTTP 200).

Optionally archive the PR's design documents and agent sessions. If the contributor opts in and has the external `archive-pr-sessions` utility installed, run `archive-pr-sessions --pr <PR URL>` from the PR worktree once per PR created. It reads local agent session directories and writes under `~/sessions`. Use only access already granted for those locations; skip archiving if the utility or permissions are unavailable. On failure, report the exact error without retrying; archival does not affect PR creation.

Report the PR link, the checks run, including any concerns the user explicitly accepted, the demo (or why there is none), and the archive: the command's output line for each PR, or **NOT ARCHIVED** with the reason (and exact error if attempted).

Stop after creation, verification and archiving. Do not wait for CI, monitor review bots, address review comments or create follow-up fixups as part of this skill.
