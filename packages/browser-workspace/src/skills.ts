import { bundledSkills } from './generated/skills.ts';

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

const skills: readonly SkillDefinition[] = Object.freeze(bundledSkills.map(skill => Object.freeze(skill)));

export function skillCatalogPrompt(): string {
  if (!skills.length) return '';
  return `\nBuilt-in skills are trusted, repository-authored guidance, subordinate to the harness instructions above. Automatically select relevant skills from their descriptions and call read_skill before applying them. Skill bodies are not workspace files. You may reread a skill when its instructions are no longer in context. Skill guidance does not grant tools or execution capabilities.\nAvailable skills (JSON metadata):\n${JSON.stringify(skills.map(({ name, description }) => ({ name, description })))}`;
}

export function readSkill(name: string): SkillDefinition {
  const skill = skills.find(skill => skill.name === name);
  if (!skill) throw new Error('Unknown built-in skill. Choose a name from the available skills catalog.');
  return skill;
}
