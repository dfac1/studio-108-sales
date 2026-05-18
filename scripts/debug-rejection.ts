process.env.DISABLE_REMOTE_SEMANTICS = "1";

const { handleSalesDialog } = await import("../src/services/salesDialog.js");
const { findSlots } = await import("../src/services/slotService.js");

console.log("=== Какие слоты вообще есть для ребёнка 8 лет? ===");
const directions = ["Hip-hop", "Йога", "Breakdance", "Lady style", "Contemporary", "Детская хореография", "Zumba", "Salsa/Bachata"];
for (const d of directions) {
  const slots = findSlots({ direction: d, age: 8, limit: 10 });
  console.log(`  ${d}: ${slots.length} слотов (${slots.slice(0, 3).map((s) => `${s.weekday} ${s.time} ${s.branch}`).join(", ")})`);
}

console.log("\n=== Сценарий: ребёнок 8 лет, отказ от хип-хопа, просит спокойнее ===");
let state: any = {};
const step = async (msg: string) => {
  const r = await handleSalesDialog({ message: msg, state });
  state = r.state;
  console.log(`\nКлиент: ${msg}`);
  console.log(`Бот:    [${r.action}] ${r.reply}`);
  console.log(`State:  name=${state.customerName} learnerType=${state.learnerType} age=${state.age} direction=${state.direction} pending=${state._pendingDirection} branch=${state.branch}`);
  return r;
};
await step("Здравствуйте");
await step("Меня зовут Валентин");
await step("Для дочки восемь лет");
await step("Нет, нам не подходит хип-хоп. Нужно что-то поспокойнее");
await step("у озера");
