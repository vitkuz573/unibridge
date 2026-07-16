---
name: generate-skill
description: Use when creating new opencode skills, writing SKILL.md files, or defining agent skill workflows. Provides templates and methodology for well-structured skills.
---

# Generate Skill

Create well-structured opencode skills following best practices.

## Skill Structure

Every skill lives in its own directory:

```
.opencode/skills/<skill-name>/SKILL.md
```

## SKILL.md Template

```markdown
---
name: <skill-name>
description: One sentence covering what this skill does AND when to trigger it. Front-load the literal keywords or filenames the user is likely to say.
---

# <Skill Title>

Clear instructions for the agent.

## When to Use

Specific trigger conditions.

## Instructions

Step-by-step workflow.

## Examples

Concrete examples of the skill in action.

## References

Links to documentation or related files.
```

## Best Practices

1. **Description**: Write in third person ("Use when...", not "I help with...")
2. **Name**: Lowercase, hyphen-separated, max 64 chars, matches folder name
3. **Front-load keywords**: Put trigger words at start of description
4. **Gate with "Use ONLY when..."**: For skills that should stay quiet on adjacent topics
5. **Be specific**: Include filenames, patterns, and concrete examples
6. **Keep it focused**: One skill, one responsibility

## Generation Workflow

1. Identify the user's need
2. Determine trigger conditions
3. Create directory: `.opencode/skills/<name>/`
4. Write `SKILL.md` with frontmatter and instructions
5. Test by restarting opencode and invoking the skill

## Common Patterns

- **Code generation**: Skills that create specific code patterns
- **Review workflows**: Skills that check code quality
- **Documentation**: Skills that generate or update docs
- **Integration**: Skills that connect external tools
- **Refactoring**: Skills that restructure code

## Directory Structure

```
.opencode/
  skills/
    my-skill/
      SKILL.md        # Main skill file
    another-skill/
      SKILL.md
```

## Registration

Skills are auto-discovered from `.opencode/skills/`. No config needed unless using non-default paths:

```json
{
  "skills": {
    "paths": [".opencode/skills", "/custom/path"]
  }
}
```
