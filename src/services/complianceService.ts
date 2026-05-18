export interface ComplianceContext {
  channel: "inbound_call" | "inbound_form" | "manual_test";
  provider: "elevenlabs" | "yandex" | "local_only";
  callRecording: boolean;
  hasPersonalDataConsent: boolean;
  hasAiDisclosure: boolean;
  hasCrossBorderConsent: boolean;
}

export function getOpeningDisclosure(callRecording: boolean): string {
  const recording = callRecording ? " Разговор может записываться для контроля качества." : "";
  return `Здравствуйте! Studio 108.${recording} Подскажите, как к вам обращаться?`;
}

export function validateCompliance(context: ComplianceContext): string[] {
  const issues: string[] = [];

  if (!context.hasPersonalDataConsent) {
    issues.push("Нужно получить согласие на обработку персональных данных до фиксации записи.");
  }

  if (context.provider === "elevenlabs" && !context.hasCrossBorderConsent) {
    issues.push("Для передачи текста/аудио в ElevenLabs нужен отдельный юридический контур трансграничной передачи персональных данных.");
  }

  if (context.callRecording && !context.hasAiDisclosure) {
    issues.push("Если включена запись разговора, лучше явно предупредить клиента в начале контакта.");
  }

  return issues;
}

export const complianceRules = [
  "MVP работает только с входящими заявками и входящими звонками.",
  "Никакого холодного обзвона и автоматического рекламного дозвона.",
  "Перед записью клиент подтверждает обработку персональных данных.",
  "При использовании ElevenLabs нужно оценить и оформить трансграничную передачу персональных данных.",
  "Если ведется запись разговора, клиент уведомляется в начале звонка.",
  "AI-ассистент не обещает скидки, возвраты и нестандартные условия.",
  "Спорные вопросы передаются человеку."
];
