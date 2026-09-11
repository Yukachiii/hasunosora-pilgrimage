import type { CardCharacter, CardModelLocation, PilgrimageSpot } from "../../app/spots";

type TrialCardFilters = {
  query: string;
  area: string;
  category: string;
  character: CardCharacter | "all";
};

export function filterTrialCards(
  cards: readonly CardModelLocation[],
  spots: readonly PilgrimageSpot[],
  filters: TrialCardFilters,
) {
  const spotsById = new Map(spots.map((spot) => [spot.id, spot]));
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("ja");

  return cards.filter((card) => {
    const spot = card.spotId ? spotsById.get(card.spotId) : undefined;
    if (filters.character !== "all" && !card.characters.includes(filters.character)) return false;
    if (filters.area !== "all" && spot?.area !== filters.area) return false;
    if (filters.category !== "all" && spot?.category !== filters.category) return false;
    if (!normalizedQuery) return true;

    return [
      card.card,
      card.model,
      card.address,
      card.note,
      ...card.characters,
      spot?.name,
      spot?.area,
      spot?.category,
    ].some((value) => value?.toLocaleLowerCase("ja").includes(normalizedQuery));
  });
}

export function mergeItineraryIds(
  currentIds: readonly string[],
  addedIds: readonly string[],
  validIds: ReadonlySet<string>,
  maximumStops: number,
) {
  return Array.from(new Set([...currentIds, ...addedIds].filter((id) => validIds.has(id))))
    .slice(0, maximumStops);
}

export function orderItemsByIds<T extends { id: string }>(
  items: readonly T[],
  orderedIds: readonly string[] | undefined,
) {
  if (!orderedIds?.length) return [...items];
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = orderedIds
    .map((id) => byId.get(id))
    .filter((item): item is T => Boolean(item));
  const includedIds = new Set(ordered.map((item) => item.id));
  return [...ordered, ...items.filter((item) => !includedIds.has(item.id))];
}

export function hasValidTimeWindow(startTime: string, endTime: string) {
  const toMinutes = (value: string) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!match) return Number.NaN;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours * 60 + minutes;
  };
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

export function retainCompletedSpotIds(
  completedIds: readonly string[],
  nextActiveDayIds: readonly string[],
  otherDayIds: readonly string[],
) {
  const retainedIds = new Set([...nextActiveDayIds, ...otherDayIds]);
  return completedIds.filter((id) => retainedIds.has(id));
}

export function hasValidVisitDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearValue, monthValue, dayValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
