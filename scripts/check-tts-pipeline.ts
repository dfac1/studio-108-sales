import { config } from "../src/config.js";
import {
  normalizeForElevenLabsRussianSpeech,
  injectProsodyBreaks,
  stripAudioTags,
  stripSsmlBreaks
} from "../src/services/russianSpeech.js";

const sample = "Андрей, для дочки в этом возрасте хорошо подходит хип-хоп. Ближайший вариант — во вторник, в 17:30 на Развилке. Пробное стоит 300 рублей. Подойдёт это время?";

console.log("\nORIGINAL:");
console.log(sample);
console.log("\nAFTER normalize (no breaks):");
const norm = normalizeForElevenLabsRussianSpeech(sample);
console.log(norm);
console.log("\nWITH prosody breaks:");
const withBreaks = injectProsodyBreaks(norm, { action: "offer_solution" });
console.log(withBreaks);
console.log("\nStripped (fallback):");
console.log(stripSsmlBreaks(withBreaks));

console.log("\n--- audio tags test ---");
const tagged = "[мягко] Конечно, понимаю. Пробное всего 300 рублей.";
console.log("Tagged:  ", tagged);
console.log("Stripped:", stripAudioTags(tagged));

console.log("\nVoice model:", config.elevenLabs.modelId);
