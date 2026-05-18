import type { Branch, PriceKind, PriceResult } from "../types.js";

export function getPrice(direction: string, branch?: Branch): PriceResult {
  const normalized = direction.toLowerCase();

  if (normalized.includes("salsa") || normalized.includes("bachata") || normalized.includes("сальс") || normalized.includes("бачат")) {
    return { trial: 400, single: 1700, subscription: null, label: "Salsa/Bachata", notes: ["Пробное по парным направлениям стоит 400 рублей."] };
  }

  if (normalized.includes("йога") && branch === "Развилка") {
    return { trial: 300, single: 1000, subscription: 4000, label: "Йога Развилка", notes: ["Абонемент: 9 занятий 4000 рублей, 13 занятий 5450 рублей."] };
  }

  if (normalized.includes("break") || normalized.includes("брейк")) {
    return {
      trial: 300,
      single: 1000,
      subscription: branch === "Развилка" ? 4700 : 4250,
      label: "Breakdance",
      notes: ["Цена абонемента зависит от филиала."]
    };
  }

  if (normalized.includes("стрип")) {
    return { trial: 300, single: 1000, subscription: 4250, label: "Стрип-пластика", notes: ["На филиале Школьная направление не ведется."] };
  }

  if (normalized.includes("pro") || normalized.includes("про")) {
    return { trial: 300, single: 1000, subscription: 4700, label: "PRO-группа" };
  }

  return { trial: 300, single: 1000, subscription: 4000, label: "Базовая цена" };
}

export function priceKindFor(direction: string, branch: Branch): PriceKind {
  return getPrice(direction, branch).label === "Salsa/Bachata"
    ? "salsa_bachata"
    : getPrice(direction, branch).label === "Breakdance"
      ? "breakdance"
      : getPrice(direction, branch).label === "Стрип-пластика"
        ? "strip"
        : getPrice(direction, branch).label === "PRO-группа"
          ? "pro"
          : getPrice(direction, branch).label === "Йога Развилка"
            ? "yoga_razvilka"
            : "base";
}
