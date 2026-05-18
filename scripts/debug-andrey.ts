process.env.DISABLE_REMOTE_SEMANTICS = "1";

const { handleSalesDialog } = await import("../src/services/salesDialog.js");

let state: any = {};

const messages = [
  "Здравствуйте, здравствуйте",
  "Меня зовут Андрей. Здравствуйте. Да, вот хотим танцевать.",
  "А-а-а, для ребёнка восьми лет, э-э-э, девочка в школу ходит",
  "А-а-а, у озера, да, больше всего подходит. Вот. Ну, мы пока ещё не определились, куда хотим ходить"
];

for (let i = 0; i < messages.length; i++) {
  const msg = messages[i];
  const r = await handleSalesDialog({ message: msg, state });
  state = r.state;
  console.log(`\n[Turn ${i + 1}]`);
  console.log(`Клиент: ${msg}`);
  console.log(`Бот:    [${r.action}] ${r.reply}`);
  console.log(`State:  name=${state.customerName} learnerType=${state.learnerType} age=${state.age} direction=${state.direction} branch=${state.branch} selectedSlotId=${state.selectedSlotId} stage=${state.stage}`);
}
