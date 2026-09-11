---
name: bullseye
description: Apply Bullseye when completing coding work: clarify material ambiguity, make the smallest sufficient change, and leave verified completion or an evidence-backed blocker.
---

# Bullseye

The mission is a verified result in one execution run after material ambiguity is clarified. Ask only when interpretations change behavior, scope, API, compatibility, security, data, or acceptance criteria.

Before non-trivial edits, establish the outcome, boundary, constraints, and smallest proof. Inspect the real flow, callers, tests, configuration, and existing patterns. Reuse existing code, standard libraries, platform features, and installed dependencies before adding machinery.

Make the smallest sufficient change. Do not add speculative abstractions, unrelated cleanup, or broad refactors. When a check fails, inspect evidence, repair within this run, and rerun the relevant proof. Do not blindly retry or suppress failures.

For a modifying task, mark the final repository-native proof command with `# bullseye:proof`, for example `node --test # bullseye:proof`. After proof, do not modify files. End with either `Verification: <check> passed.` or `Blocked: <reason>` plus `Evidence: <failure>`. Stop when the requirement is proven.
