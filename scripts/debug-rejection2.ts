process.env.DISABLE_REMOTE_SEMANTICS = "1";

const { handleSalesDialog } = await import("../src/services/salesDialog.js");

let state: any = {};
const step = async (msg: string) => {
  const r = await handleSalesDialog({ message: msg, state });
  state = r.state;
  console.log(`\nКлиент: ${msg}`);
  console.log(`Бот:    [${r.action}] ${r.reply}`);
  console.log(`State:  direction=${state.direction} pending=${state._pendingDirection} rejected=${(state.rejectedDirections ?? []).join(",")}`);
  return r;
};

await step("Здрасьте");
await step("Меня зовут Андрей");
await step("А-а-а, для ребёнка, девочки восьми лет. Вот, потанцевать хотим");
await step("Прием?");
await step("А-а-а, не, хип-хоп не очень нам подходит");
await step("Озеро");
