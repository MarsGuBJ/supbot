import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  containsChinese,
  readBundledSkillNames,
  readSkillTranslationLastRunDate,
  translateEnglishSkills,
  translateSkillFile,
  writeSkillTranslationLastRunDate,
} from "../src/skillTranslator";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supbot-skill-translator-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(dir: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
}

const ENGLISH_SKILL = [
  "---",
  "name: demo-skill",
  "description: Does a thing.",
  "---",
  "",
  "# Usage",
  "",
  "Run it.",
].join("\n");

const CHINESE_TRANSLATION = [
  "---",
  "name: demo-skill",
  "description: 做一件事情。",
  "---",
  "",
  "# 用法",
  "",
  "运行它。",
].join("\n");

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("containsChinese", () => {
  test("returns false for pure English text", () => {
    expect(containsChinese(ENGLISH_SKILL)).toBe(false);
  });

  test("returns true when any Chinese character is present", () => {
    expect(containsChinese("Translate skills. 翻译。")).toBe(true);
  });

  test("returns true for mixed content with a single Chinese character", () => {
    expect(containsChinese("# Usage\n\n运行 it.")).toBe(true);
  });
});

describe("translateSkillFile", () => {
  test("translates an English-only SKILL.md and writes a marker", async () => {
    const root = await createTempDir();
    const skillDir = join(root, "demo-skill");
    await writeSkill(skillDir, ENGLISH_SKILL);
    const status = await translateSkillFile(skillDir, async () => CHINESE_TRANSLATION);
    expect(status).toBe("translated");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(`${CHINESE_TRANSLATION}\n`);
    const marker = JSON.parse(await readFile(join(skillDir, ".translated-zh"), "utf8"));
    expect(marker.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("skips content that contains Chinese (mixed content rule)", async () => {
    const root = await createTempDir();
    const skillDir = join(root, "mixed-skill");
    const mixed = `${ENGLISH_SKILL}\n\n备注：中英混合。\n`;
    await writeSkill(skillDir, mixed);
    let called = false;
    const status = await translateSkillFile(skillDir, async () => {
      called = true;
      return CHINESE_TRANSLATION;
    });
    expect(status).toBe("skipped-chinese");
    expect(called).toBe(false);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(mixed);
  });

  test("skips when the marker matches the unchanged source", async () => {
    const root = await createTempDir();
    const skillDir = join(root, "demo-skill");
    await writeSkill(skillDir, ENGLISH_SKILL);
    let calls = 0;
    const callLlm = async () => {
      calls += 1;
      return CHINESE_TRANSLATION;
    };
    // Marker records the hash of the English source even though the file on
    // disk is the translation; restore the source to simulate a rescan edge.
    await translateSkillFile(skillDir, callLlm);
    await writeSkill(skillDir, ENGLISH_SKILL);
    const status = await translateSkillFile(skillDir, callLlm);
    expect(status).toBe("skipped-already-translated");
    expect(calls).toBe(1);
  });

  test("retranslates when the source changed after a previous translation", async () => {
    const root = await createTempDir();
    const skillDir = join(root, "demo-skill");
    await writeSkill(skillDir, ENGLISH_SKILL);
    await translateSkillFile(skillDir, async () => CHINESE_TRANSLATION);
    const updated = `${ENGLISH_SKILL}\n\n## New section\n`;
    await writeSkill(skillDir, updated);
    const status = await translateSkillFile(skillDir, async () => CHINESE_TRANSLATION);
    expect(status).toBe("translated");
  });

  test("keeps the original file when the LLM output loses the frontmatter", async () => {
    const root = await createTempDir();
    const skillDir = join(root, "demo-skill");
    await writeSkill(skillDir, ENGLISH_SKILL);
    const status = await translateSkillFile(skillDir, async () => "没有 frontmatter 的输出。");
    expect(status).toBe("failed");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(ENGLISH_SKILL);
  });

  test("keeps the original file when the LLM throws", async () => {
    const root = await createTempDir();
    const skillDir = join(root, "demo-skill");
    await writeSkill(skillDir, ENGLISH_SKILL);
    const status = await translateSkillFile(skillDir, async () => {
      throw new Error("LLM unavailable");
    });
    expect(status).toBe("failed");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(ENGLISH_SKILL);
  });

  test("unwraps a code fence around the LLM output", async () => {
    const root = await createTempDir();
    const skillDir = join(root, "demo-skill");
    await writeSkill(skillDir, ENGLISH_SKILL);
    const status = await translateSkillFile(skillDir, async () => `\`\`\`markdown\n${CHINESE_TRANSLATION}\n\`\`\``);
    expect(status).toBe("translated");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(`${CHINESE_TRANSLATION}\n`);
  });

  test("returns skipped-no-skillmd when SKILL.md is missing", async () => {
    const root = await createTempDir();
    const status = await translateSkillFile(join(root, "empty-skill"), async () => CHINESE_TRANSLATION);
    expect(status).toBe("skipped-no-skillmd");
  });
});

describe("translateEnglishSkills", () => {
  test("translates English skills, skips Chinese ones and dot-prefixed dirs", async () => {
    const root = await createTempDir();
    await writeSkill(join(root, "english-skill"), ENGLISH_SKILL);
    await writeSkill(join(root, "chinese-skill"), CHINESE_TRANSLATION);
    await writeSkill(join(root, ".backup-old"), ENGLISH_SKILL);
    const summary = await translateEnglishSkills(root, async () => CHINESE_TRANSLATION);
    expect(summary.translated).toEqual(["english-skill"]);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toBe(1);
  });

  test("honours excludeDirs for bundled skills", async () => {
    const root = await createTempDir();
    await writeSkill(join(root, "bundled-skill"), ENGLISH_SKILL);
    await writeSkill(join(root, "user-skill"), ENGLISH_SKILL);
    const summary = await translateEnglishSkills(root, async () => CHINESE_TRANSLATION, {
      excludeDirs: new Set(["bundled-skill"]),
    });
    expect(summary.translated).toEqual(["user-skill"]);
  });
});

describe("scheduler state persistence", () => {
  test("round-trips the last run date", async () => {
    const root = await createTempDir();
    expect(await readSkillTranslationLastRunDate(root)).toBeUndefined();
    await writeSkillTranslationLastRunDate(root, "2026-9-18");
    expect(await readSkillTranslationLastRunDate(root)).toBe("2026-9-18");
  });
});

describe("readBundledSkillNames", () => {
  test("reads skill names from the seed marker manifest", async () => {
    const root = await createTempDir();
    await writeFile(
      join(root, "default-data-seed.json"),
      JSON.stringify({ manifest: { skills: ["alpha", "beta"] } }),
      "utf8",
    );
    expect(await readBundledSkillNames(root)).toEqual(new Set(["alpha", "beta"]));
  });

  test("returns an empty set when the marker is missing", async () => {
    const root = await createTempDir();
    expect(await readBundledSkillNames(root)).toEqual(new Set());
  });
});
