# Plugin 0.3.0: model aliases and tier config

Status: in progress on `feat/haiku-5-5`. Ships with `2.0.0-alpha.6`.

## Why

Robe wants the models configurable and the Haiku Builder on Haiku 5.5.

The original spec wanted per-role models in `pipeline.json`, written into the agent files by
`npm run wire -- --pipeline`. Phase 4a dropped that when the pipeline became a plugin, for two
reasons:
- the plugin's agent files live in Claude Code's plugin cache, and an update replaces them;
- the app only observes, so it must not rewrite them.

So 0.1.0 and 0.2.0 pinned exact model IDs.

Claude Code has no documented way for a plugin to set an agent's model from its own config at
runtime. Sources, checked 2026-10-16: code.claude.com/docs/en/sub-agents.md, skills.md,
model-config.md, plugins/manifest-reference.md and plugins/loading.md.

## Decision (Robe, 2026-10-16)

- **Aliases, not IDs.** Every plugin agent and skill sets `model:` to `haiku`, `sonnet`, `opus`
  or `fable`. Each alias follows the current model of its tier on the user's provider. On the
  Anthropic API today, `haiku` means Haiku 5.5. On Bedrock and Vertex the aliases map to older
  versions.
- **Repointing a tier.** A user who wants a different version for a tier sets
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, or the `_SONNET_`, `_OPUS_` and `_FABLE_` equivalents, in
  their Claude Code settings. The setting is global to Claude Code, not specific to Sereno.
- **Per-role choice is by tier, in `pipeline.json`:**
  - `roles.builder.allowed` is new. It lists the Builder tiers a spec may choose, and the spec
    command enforces it.
  - `roles.builder.default` is unchanged.
  - The preset (`default`, `lean`) chooses the red team and its fallback.
- **Removed:** the inert `roles.builder.options.*.model` fields.

## Trade-off

Runs are no longer pinned to an exact model version. The ledger still records the model that
actually answered each request, so cost and attribution are unaffected.

## Steps

- **A1, plugin:**
  - aliases in every agent and skill;
  - config cleanup and `allowed`;
  - spec enforcement;
  - task skill text;
  - README;
  - version 0.3.0;
  - tests.
- **A2, app:**
  - Model matching moves from exact IDs to tier families: `inferModels`, friendly names, routing
    and the gate model.
  - An alias in an agent file maps to the family. A request's model ID maps to a family by its
    name, for example `claude-haiku-5-5` maps to haiku.
  - `inferModels` stays "a family used by exactly one role", which today means only Fable maps
    to the red team.
- Then the red team on the branch, then merge.
