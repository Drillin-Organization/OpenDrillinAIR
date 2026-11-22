# OpenDrillinAIR

This folder is the brain for the Drillin AIR characters. Type `/soul` to become their mind. Everything you need is in `.claude/skills/soul/SKILL.md` and `brain/prompts/system.md`.

When the user asks to change the brain itself (not a character), the code is in `brain/src/` (TypeScript, run with tsx; check with `cd brain && npx tsc --noEmit`). The brain process only picks up code changes after `/mcp` → drillin-body → Reconnect.
