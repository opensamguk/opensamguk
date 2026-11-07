import type { HistoricEventsConfig, HistoricEventsState } from './state';

export function historicEventsView(
  historicEvents: { config: HistoricEventsConfig; state: HistoricEventsState } | undefined,
  viewerNationId: number | null,
) {
  if (!historicEvents) return { enabled: false as const, mine: [], done: [] };
  const { config, state } = historicEvents;
  const events = new Map(config.events.map((event) => [event.id, event]));
  const mine = state.pending
    .filter(({ nationId }) => nationId === viewerNationId)
    .map(({ id, choice, closesAtMonth }) => {
      const { title, text, counterpart, options, defaultOption } = events.get(id)!;
      return { id, title, text, counterpart, options, defaultOption, choice, closesAtMonth };
    });
  const done = state.done.flatMap(({ id, choice, defaulted, resolvedTick }) => {
    if (choice === null) return [];
    const { title, chooser, options } = events.get(id)!;
    return [{ id, title, nation: chooser, choice, choiceLabel: options[choice].label, defaulted, resolvedTick }];
  });
  return { enabled: true as const, mine, done };
}
