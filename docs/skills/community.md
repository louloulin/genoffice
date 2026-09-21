# Community Skills

Third-party Skills live in their own repositories. Submit a PR to
add your Skill to this list.

## Submission checklist

- [ ] npm package published under `@genoffice/skill-<name>` (provenance enabled).
- [ ] Default export implements `SkillPackage` (`packages/agent-skills/src/skill-protocol.ts`).
- [ ] Repository has a `README.md`, `LICENSE` (Apache-2.0 compatible), and `CHANGELOG.md`.
- [ ] At least one integration test in `tests/`.
- [ ] Triggers don't overlap with an official Skill.
- [ ] Required permissions are documented in the Skill manifest.

## Submission process

1. Open a PR against `genspark-ai/genoffice` modifying
   `docs/skills/community.md` and `docs/skills/.well-known/skills.json`.
2. Maintainer review — typically 5 business days.
3. Merge + automatic sync to `genoffice.app/skills`.

## Featured Skills

_(no community submissions yet — be the first!)_
