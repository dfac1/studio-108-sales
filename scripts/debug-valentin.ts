// Воспроизводит точный диалог Валентина из жалобы пользователя.
// Цель — проверить, что фиксы реально работают на этом потоке.

process.env.DISABLE_REMOTE_SEMANTICS = "1";

const { handleSalesDialog } = await import("../src/services/salesDialog.js");

let state: any = {};

const messages = [
  "Валентин меня зовут. Здравствуйте",
  "А-а-а, для ребёнка, девочка восьми лет",
  "Что значит, э-э-э, посмотреть?",
  "А-а-а, ну, нам надо что-то популярное, вот чтобыыы",
  "М-м, э-э-э, популярное что-то хотим. Я же сказал уже"
];

for (let i = 0; i < messages.length; i++) {
  const msg = messages[i];
  const r = await handleSalesDialog({ message: msg, state });
  state = r.state;
  console.log(`\n[Turn ${i + 1}]`);
  console.log(`Клиент: ${msg}`);
  console.log(`Бот:    [${r.action}] ${r.reply}`);
  console.log(`State:  name=${state.customerName} learnerType=${state.learnerType} age=${state.age} direction=${state.direction} need="${state.need?.slice(0, 50) ?? ""}" branch=${state.branch}`);
  console.log(`Recent: ${(state.recentActions ?? []).join(",")}`);
}
