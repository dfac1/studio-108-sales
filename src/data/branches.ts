import type { Branch } from "../types.js";

export const branches: Record<Branch, { address: string; floor?: string; landmarks: string[]; phone: string }> = {
  "Развилка": {
    address: "ул. Герцена 52Д",
    floor: "3-й этаж",
    landmarks: ["напротив остановки Герцена"],
    phone: "8 918 942-51-62"
  },
  "Озеро": {
    address: "ул. Псекупская 149А",
    floor: "1-й этаж",
    landmarks: ["район озера", "рядом с овощебазой"],
    phone: "8 993 320-81-08"
  },
  "Школьная": {
    address: "ул. Школьная 24",
    floor: "2-й этаж",
    landmarks: ["район 1-й школы", "центральная площадь", "рядом с ДоДо Пицца"],
    phone: "8 993 320-81-08"
  },
  "Черняховского": {
    address: "ул. Черняховского",
    landmarks: [],
    phone: "8 993 320-81-08"
  }
};
