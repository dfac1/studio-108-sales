import { describe, expect, it } from "vitest";
import { classifyCustomerProfile, profileGuidanceForBrain } from "./customerProfile.js";

describe("customerProfile classifier", () => {
  it("classifies mom with child as young_parent", () => {
    const result = classifyCustomerProfile({
      state: { learnerType: "child", age: 6, childGender: "girl" },
      recentMessages: ["Для дочки шесть лет, хочу попробовать танцы"]
    });
    expect(result.profile).toBe("young_parent");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("classifies teenager as teen", () => {
    const result = classifyCustomerProfile({
      state: { learnerType: "adult", age: 15 },
      recentMessages: ["хочу попробовать хип-хоп"]
    });
    expect(result.profile).toBe("teen");
  });

  it("classifies busy adult by explicit time markers", () => {
    const result = classifyCustomerProfile({
      state: { learnerType: "adult" },
      recentMessages: ["могу только после работы, очень занят"]
    });
    expect(result.profile).toBe("busy_adult");
  });

  it("classifies 50+ adult as mature", () => {
    const result = classifyCustomerProfile({
      state: { learnerType: "adult", age: 52 },
      recentMessages: ["для себя, хочется попробовать йогу"]
    });
    expect(result.profile).toBe("mature");
  });

  it("falls back to unknown when data is sparse", () => {
    const result = classifyCustomerProfile({
      state: {},
      recentMessages: ["здравствуйте"]
    });
    expect(result.profile).toBe("unknown");
  });

  it("provides guidance text for each profile", () => {
    expect(profileGuidanceForBrain("young_parent")).toContain("родитель");
    expect(profileGuidanceForBrain("teen")).toContain("подросток");
    expect(profileGuidanceForBrain("busy_adult")).toContain("занятой");
    expect(profileGuidanceForBrain("mature")).toContain("зрелый");
    expect(profileGuidanceForBrain("unknown")).toContain("не определён");
  });
});
