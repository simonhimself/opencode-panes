# Issue tracker: Local Markdown

Issues and specs live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- Spec: `.scratch/<feature-slug>/spec.md`
- Tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- Record triage state in a `Status:` line.
- Append discussion under `## Comments`.
- Record dependencies in a `Blocked by:` line.

When publishing work, create the appropriate file under `.scratch/`.
When fetching work, read the referenced path or issue number.
