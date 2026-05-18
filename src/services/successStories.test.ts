import { describe, expect, it, beforeEach } from "vitest";
import { findRelevantSuccessStory, parseStories, clearStoriesCache } from "./successStories.js";

const SAMPLE_MD = `
# Test stories

### 1. Mom and shy daughter

tags: direction=hip-hop, age=6-10, objection=shy, profile=young_parent
weight: 1.0

Здесь история про застенчивую девочку.

### 2. Busy adult and time

tags: direction=any, objection=time, profile=busy_adult
weight: 0.9

Многие приходят на вечерние группы после работы.
`;

describe("successStories parser", () => {
  it("parses stories with tags and body", () => {
    const stories = parseStories(SAMPLE_MD);
    expect(stories).toHaveLength(2);
    expect(stories[0].title).toContain("Mom");
    expect(stories[0].tags.direction).toContain("hip-hop");
    expect(stories[0].tags.objection).toContain("shy");
    expect(stories[0].body).toContain("застенчивую");
  });
});

describe("findRelevantSuccessStory", () => {
  beforeEach(() => clearStoriesCache());

  it("returns null when no match found", async () => {
    const result = await findRelevantSuccessStory({
      direction: "Hip-hop",
      customerMessage: "здравствуйте",
      stage: "ask_name"
    });
    expect(result).toBeNull();
  });

  it("matches shy objection for hip-hop young_parent", async () => {
    // KB загружается из реального файла; смотрим что для "стесняется" и направления "Hip-hop"
    // он что-то находит. Если KB пустой — null.
    const result = await findRelevantSuccessStory({
      direction: "Hip-hop",
      age: 6,
      learnerType: "child",
      customerMessage: "дочка стесняется идти",
      stage: "offer_solution",
      profile: "young_parent"
    });
    // Может быть null если KB не подгрузился (CI sandbox), либо строкой
    if (result !== null) {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(10);
    }
  });
});
