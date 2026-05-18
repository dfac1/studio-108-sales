import type { Slot } from "../types.js";
import { priceKindFor } from "./pricing.js";

function slot(input: Omit<Slot, "id" | "clientVisible" | "priceKind" | "capacity" | "freePlaces">): Slot {
  const slug = `${input.weekday}-${input.branch}-${input.time}-${input.direction}-${input.teacher}`
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, "-")
    .replace(/^-|-$/g, "");

  return {
    ...input,
    id: slug,
    clientVisible: input.branch !== "Черняховского",
    priceKind: priceKindFor(input.direction, input.branch),
    capacity: 0,
    freePlaces: 0
  };
}

export const slots: Slot[] = [
  slot({ weekday: "Пн", branch: "Озеро", time: "11:00", direction: "Contemporary", level: "начальная утро", teacher: "Вероника" }),
  slot({ weekday: "Пн", branch: "Озеро", time: "12:00", direction: "Contemporary", level: "взрослые", ageMin: 16, teacher: "Анастасия Б" }),
  slot({ weekday: "Пн", branch: "Развилка", time: "16:00", direction: "Hip-hop", level: "начальная", teacher: "Дарина" }),
  slot({ weekday: "Пн", branch: "Озеро", time: "16:00", direction: "Contemporary", level: "начальная день", teacher: "Вероника" }),
  slot({ weekday: "Пн", branch: "Озеро", time: "17:00", direction: "Детская хореография", level: "дети", ageMax: 12, teacher: "Анастасия Б" }),
  slot({ weekday: "Пн", branch: "Школьная", time: "17:00", direction: "Breakdance", teacher: "Константин" }),
  slot({ weekday: "Пн", branch: "Развилка", time: "18:00", direction: "Hip-hop PRO", level: "PRO", teacher: "Виталий" }),
  slot({ weekday: "Пн", branch: "Школьная", time: "18:00", direction: "Jazz funk", teacher: "Алина" }),
  slot({ weekday: "Пн", branch: "Озеро", time: "19:00", direction: "Йога", level: "вечер", ageMin: 16, teacher: "Кристина" }),
  slot({ weekday: "Пн", branch: "Развилка", time: "19:40", direction: "Contemporary", level: "взрослые", ageMin: 16, teacher: "Анастасия Б" }),
  slot({ weekday: "Пн", branch: "Озеро", time: "20:00", direction: "Dancehall", ageMin: 16, teacher: "Кристина" }),

  slot({ weekday: "Вт", branch: "Развилка", time: "09:00", direction: "Йога", level: "утро", ageMin: 16, teacher: "Кристина" }),
  slot({ weekday: "Вт", branch: "Черняховского", time: "09:00", direction: "Zumba", ageMin: 16, teacher: "Анастасия К" }),
  slot({ weekday: "Вт", branch: "Развилка", time: "15:00", direction: "Contemporary", level: "начальная", teacher: "Анастасия Б" }),
  slot({ weekday: "Вт", branch: "Развилка", time: "16:00", direction: "Contemporary PRO", level: "PRO", teacher: "Анастасия Б" }),
  slot({ weekday: "Вт", branch: "Озеро", time: "17:15", direction: "Hip-hop", level: "4-6 лет", ageMin: 4, ageMax: 6, teacher: "Дарина" }),
  slot({ weekday: "Вт", branch: "Развилка", time: "17:30", direction: "Hip-hop", level: "4-6 лет", ageMin: 4, ageMax: 6, teacher: "Анна" }),
  slot({ weekday: "Вт", branch: "Развилка", time: "18:30", direction: "Breakdance", teacher: "Константин" }),
  slot({ weekday: "Вт", branch: "Школьная", time: "18:30", direction: "Восточные танцы", level: "начальная", teacher: "Валерия" }),
  slot({ weekday: "Вт", branch: "Школьная", time: "19:30", direction: "Hip-hop", level: "начальная", teacher: "Анна" }),
  slot({ weekday: "Вт", branch: "Озеро", time: "20:00", direction: "Lady style", ageMin: 16, teacher: "Анжелика" }),
  slot({ weekday: "Вт", branch: "Развилка", time: "20:00", direction: "Hip-hop", level: "взрослые", ageMin: 16, teacher: "Виталий" }),

  slot({ weekday: "Ср", branch: "Озеро", time: "16:00", direction: "Hip-hop", level: "начальная", teacher: "Соня" }),
  slot({ weekday: "Ср", branch: "Озеро", time: "17:00", direction: "Детская хореография", level: "дети", ageMax: 12, teacher: "Анастасия Б" }),
  slot({ weekday: "Ср", branch: "Развилка", time: "18:00", direction: "Hip-hop PRO", level: "PRO", teacher: "Виталий" }),
  slot({ weekday: "Ср", branch: "Школьная", time: "18:00", direction: "Jazz funk", teacher: "Алина" }),
  slot({ weekday: "Ср", branch: "Школьная", time: "19:00", direction: "Восточные танцы", teacher: "Валерия" }),
  slot({ weekday: "Ср", branch: "Озеро", time: "19:00", direction: "Стрип-пластика", ageMin: 18, teacher: "Виолетта" }),
  slot({ weekday: "Ср", branch: "Развилка", time: "19:30", direction: "Zumba", ageMin: 16, teacher: "Анастасия К" }),
  slot({ weekday: "Ср", branch: "Озеро", time: "20:00", direction: "Breakdance", teacher: "Виталий" }),

  slot({ weekday: "Чт", branch: "Развилка", time: "09:00", direction: "Йога", level: "утро", ageMin: 16, teacher: "Кристина" }),
  slot({ weekday: "Чт", branch: "Черняховского", time: "09:00", direction: "Zumba", ageMin: 16, teacher: "Анастасия К" }),
  slot({ weekday: "Чт", branch: "Озеро", time: "11:00", direction: "Contemporary", level: "начальная утро", teacher: "Вероника" }),
  slot({ weekday: "Чт", branch: "Озеро", time: "12:00", direction: "Contemporary", level: "взрослые", ageMin: 16, teacher: "Анастасия Б" }),
  slot({ weekday: "Чт", branch: "Озеро", time: "15:00", direction: "Contemporary", level: "начальная день", teacher: "Вероника" }),
  slot({ weekday: "Чт", branch: "Развилка", time: "15:30", direction: "Hip-hop", level: "начальная", teacher: "Дарина" }),
  slot({ weekday: "Чт", branch: "Развилка", time: "16:30", direction: "Contemporary", level: "начальная", teacher: "Анастасия Б" }),
  slot({ weekday: "Чт", branch: "Озеро", time: "17:15", direction: "Hip-hop", level: "4-6 лет", ageMin: 4, ageMax: 6, teacher: "Виталий" }),
  slot({ weekday: "Чт", branch: "Развилка", time: "17:30", direction: "Hip-hop", level: "4-6 лет", ageMin: 4, ageMax: 6, teacher: "Анна" }),
  slot({ weekday: "Чт", branch: "Развилка", time: "18:30", direction: "Стрип-пластика", ageMin: 18, teacher: "Виолетта" }),
  slot({ weekday: "Чт", branch: "Школьная", time: "18:30", direction: "Восточные танцы", level: "начальная", teacher: "Валерия" }),
  slot({ weekday: "Чт", branch: "Школьная", time: "19:30", direction: "Hip-hop", level: "начальная", teacher: "Анна" }),
  slot({ weekday: "Чт", branch: "Озеро", time: "20:00", direction: "Lady style", ageMin: 16, teacher: "Анжелика" }),
  slot({ weekday: "Чт", branch: "Развилка", time: "20:00", direction: "Hip-hop", level: "взрослые", ageMin: 16, teacher: "Виталий" }),

  slot({ weekday: "Пт", branch: "Развилка", time: "15:00", direction: "Contemporary PRO", level: "PRO", teacher: "Анастасия Б" }),
  slot({ weekday: "Пт", branch: "Развилка", time: "15:30", direction: "K-pop", teacher: "Рина" }),
  slot({ weekday: "Пт", branch: "Школьная", time: "16:00", direction: "Breakdance", teacher: "Константин" }),
  slot({ weekday: "Пт", branch: "Развилка", time: "16:30", direction: "K-pop", teacher: "Рина" }),
  slot({ weekday: "Пт", branch: "Развилка", time: "18:00", direction: "Hip-hop PRO", level: "PRO", teacher: "Виталий" }),
  slot({ weekday: "Пт", branch: "Озеро", time: "19:00", direction: "Йога", level: "вечер", ageMin: 16, teacher: "Кристина" }),
  slot({ weekday: "Пт", branch: "Развилка", time: "19:40", direction: "Contemporary", level: "взрослые", ageMin: 16, teacher: "Анастасия Б" }),
  slot({ weekday: "Пт", branch: "Озеро", time: "20:00", direction: "Dancehall", ageMin: 16, teacher: "Кристина" }),

  slot({ weekday: "Сб", branch: "Развилка", time: "09:00", direction: "Йога", ageMin: 16, teacher: "Кристина" }),
  slot({ weekday: "Сб", branch: "Озеро", time: "11:00", direction: "Hip-hop", level: "начальная утро", teacher: "Соня" }),
  slot({ weekday: "Сб", branch: "Озеро", time: "12:00", direction: "Salsa/Bachata", level: "начальная", ageMin: 16, teacher: "Оксана" }),
  slot({ weekday: "Сб", branch: "Развилка", time: "13:00", direction: "Breakdance", teacher: "Константин" }),
  slot({ weekday: "Сб", branch: "Озеро", time: "14:00", direction: "Salsa/Bachata", ageMin: 16, teacher: "Оксана" }),
  slot({ weekday: "Сб", branch: "Озеро", time: "15:00", direction: "Breakdance", teacher: "Виталий" }),
  slot({ weekday: "Сб", branch: "Развилка", time: "17:00", direction: "Zumba", ageMin: 16, teacher: "Анастасия К" }),
  slot({ weekday: "Сб", branch: "Озеро", time: "17:00", direction: "Стрип-пластика", ageMin: 18, teacher: "Виолетта" }),
  slot({ weekday: "Сб", branch: "Школьная", time: "18:30", direction: "Восточные танцы", teacher: "Валерия" }),

  slot({ weekday: "Вс", branch: "Развилка", time: "11:00", direction: "Salsa", level: "старшая", ageMin: 16, teacher: "Александр" }),
  slot({ weekday: "Вс", branch: "Развилка", time: "14:00", direction: "Salsa", level: "начальная", ageMin: 16, teacher: "Александр" }),
  slot({ weekday: "Вс", branch: "Развилка", time: "18:00", direction: "Стрип-пластика", ageMin: 18, teacher: "Виолетта" })
];
