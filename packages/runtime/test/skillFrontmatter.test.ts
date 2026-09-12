import { describe, expect, test } from "vitest";
import { parseSkillFrontmatter } from "@supbot/shared";

describe("parseSkillFrontmatter", () => {
  test("reads plain scalar values", () => {
    const metadata = parseSkillFrontmatter(
      ['---', "name: demo-skill", 'description: "Does a thing."', "version: '1.2'", "---", "", "# Body"].join(
        "\n",
      ),
    );
    expect(metadata).toEqual({ name: "demo-skill", description: "Does a thing.", version: "1.2" });
  });

  test("folds a multi-line folded block scalar (>) into one line", () => {
    const metadata = parseSkillFrontmatter(
      [
        "---",
        "name: credit-risk-analyzer-V1",
        "description: >",
        "  企业信用风险热点分析 V1（批判性思维增强版）。当用户要求分析某个新闻事件",
        "  或监管政策对企业信用资质（违约风险）的影响时触发。",
        "  输入为使用者提供的新闻或政策文本。",
        "allowed-tools:",
        "  - Read",
        "---",
      ].join("\n"),
    );
    expect(metadata.name).toBe("credit-risk-analyzer-V1");
    expect(metadata.description).toBe(
      "企业信用风险热点分析 V1（批判性思维增强版）。当用户要求分析某个新闻事件 或监管政策对企业信用资质（违约风险）的影响时触发。 输入为使用者提供的新闻或政策文本。",
    );
  });

  test("keeps line breaks for literal block scalars (|)", () => {
    const metadata = parseSkillFrontmatter(
      ["---", "name: demo", "description: |", "  first line", "  second line", "---"].join("\n"),
    );
    expect(metadata.description).toBe("first line\nsecond line");
  });

  test("blank lines inside folded blocks become paragraph breaks", () => {
    const metadata = parseSkillFrontmatter(
      ["---", "name: demo", "description: >", "  first", "", "  second", "---"].join("\n"),
    );
    expect(metadata.description).toBe("first\nsecond");
  });

  test("returns an empty object without front matter", () => {
    expect(parseSkillFrontmatter("# no front matter")).toEqual({});
  });
});
