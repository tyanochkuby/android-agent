import { actOn, runUiWorkflow, select } from './uiWorkflow';

export function openStationDirections() {
  return runUiWorkflow('com.google.android.apps.maps', async ui => {
    const station = 'Warsaw Central Station';
    const search = () =>
      ui.waitFor(snapshot =>
        select(
          snapshot,
          element => element.label === 'Search here',
          'clickable',
        ),
      );
    await actOn(search, ui.click);

    const field = () =>
      ui.waitFor(snapshot =>
        select(snapshot, element => element.editable, 'editable'),
      );
    await actOn(field, selection => ui.setText(selection, station));

    const result = () =>
      ui.waitFor(snapshot =>
        select(
          snapshot,
          element => element.label === station && !element.editable,
          'clickable',
        ),
      );
    await actOn(result, ui.click);

    const directions = () =>
      ui.waitFor(snapshot =>
        select(
          snapshot,
          element =>
            element.label === 'Directions' &&
            !element.resourceId?.endsWith('/on_map_directions_button'),
          'clickable',
        ),
      );
    await actOn(directions, ui.click);

    const destination = await ui.waitFor(snapshot =>
      snapshot.elements.some(element =>
        element.label.startsWith('Walking mode'),
      )
        ? select(
            snapshot,
            element =>
              element.description?.startsWith('Destination, Warsaw Central') ===
              true,
          )
        : undefined,
    );
    return destination.snapshot.elements[destination.index].label;
  });
}
