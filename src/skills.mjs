import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_AGENTS = {
  cursor: ".cursor/skills",
  claude: ".claude/skills",
  codex: ".agents/skills"
};

export const DEFAULT_SKILL_AGENTS = Object.keys(SKILL_AGENTS);

export function skillsPackRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
}

export function listSkills(packRoot = skillsPackRoot()) {
  if (!existsSync(packRoot)) {
    throw new Error(`BenchRouter skill pack is missing at ${packRoot}.`);
  }
  return readdirSync(packRoot)
    .filter((name) => statSync(path.join(packRoot, name)).isDirectory())
    .map((name) => readSkill(name, packRoot))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function readSkill(name, packRoot = skillsPackRoot()) {
  const skillName = normalizeSkillName(name);
  const skillDir = path.join(packRoot, skillName);
  const skillPath = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new Error(`Unknown skill: ${skillName}. Try: ${listSkillNames(packRoot).join(", ") || "(none)"}.`);
  }
  const source = readFileSync(skillPath, "utf8");
  const parsed = parseSkillMarkdown(source);
  if (parsed.name !== skillName) {
    throw new Error(`Skill ${skillName} has mismatched frontmatter name ${parsed.name}.`);
  }
  return {
    name: skillName,
    description: parsed.description,
    content: source,
    files: listSkillFiles(skillDir)
  };
}

export function listSkillNames(packRoot = skillsPackRoot()) {
  return listSkills(packRoot).map((skill) => skill.name);
}

export function parseAgents(raw) {
  if (raw === undefined || raw === true) {
    return [...DEFAULT_SKILL_AGENTS];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const names = values
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (names.length === 0 || names.includes("all")) {
    return [...DEFAULT_SKILL_AGENTS];
  }
  const unknown = names.filter((name) => !SKILL_AGENTS[name]);
  if (unknown.length > 0) {
    throw new Error(`Unknown agent: ${unknown.join(", ")}. Use cursor, claude, codex, or all.`);
  }
  return [...new Set(names)];
}

export function planSkillInstall({
  root,
  agents = DEFAULT_SKILL_AGENTS,
  names,
  packRoot = skillsPackRoot()
}) {
  const skills = (names && names.length > 0 ? names : listSkillNames(packRoot)).map((name) => readSkill(name, packRoot));
  const files = [];
  for (const agent of agents) {
    const destRoot = SKILL_AGENTS[agent];
    if (!destRoot) {
      throw new Error(`Unknown agent: ${agent}. Use cursor, claude, codex, or all.`);
    }
    for (const skill of skills) {
      for (const file of skill.files) {
        const relativePath = path.posix.join(destRoot, skill.name, file.relativePath);
        const targetPath = path.join(root, ...relativePath.split("/"));
        const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
        files.push({
          agent,
          skill: skill.name,
          path: relativePath,
          content: file.content,
          action: previous === null ? "create" : previous === file.content ? "unchanged" : "update"
        });
      }
    }
  }
  return {
    ok: true,
    agents,
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    files
  };
}

export function applySkillInstall(plan, root) {
  for (const file of plan.files) {
    if (file.action === "unchanged") continue;
    const targetPath = safeTargetPath(root, file.path);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, file.content);
  }
  return plan;
}

export function parseSkillMarkdown(source) {
  if (!source.startsWith("---\n")) {
    throw new Error("SKILL.md must start with YAML frontmatter.");
  }
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("SKILL.md frontmatter is not closed.");
  }
  const fields = {};
  for (const line of source.slice(4, end).split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) fields[key] = value;
  }
  if (!fields.name || !fields.description) {
    throw new Error("SKILL.md frontmatter must include name and description.");
  }
  return {
    name: normalizeSkillName(fields.name),
    description: fields.description,
    body: source.slice(end + 5)
  };
}

function listSkillFiles(skillDir) {
  const files = [];
  walk(skillDir, "", files);
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw new Error(`${skillDir} is missing SKILL.md.`);
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function walk(dir, prefix, files) {
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(absolute).isDirectory()) {
      walk(absolute, relativePath, files);
      continue;
    }
    files.push({
      relativePath,
      content: readFileSync(absolute, "utf8")
    });
  }
}

function normalizeSkillName(name) {
  const value = String(name ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid skill name: ${name}. Use lowercase letters, numbers, and hyphens.`);
  }
  return value;
}

function safeTargetPath(root, relativePath) {
  if (relativePath.includes("\0") || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Refusing to write skill path: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Refusing to write skill path: ${relativePath}`);
  }
  return resolved;
}
