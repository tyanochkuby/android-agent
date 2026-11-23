import { runAgent } from '../src/agent';
import type { AgentTools, Model } from '../src/agent';

function device() {
  return {
    startTimer: jest.fn<ReturnType<AgentTools['startTimer']>, [number]>(),
    openApp: jest.fn().mockResolvedValue(undefined),
    observeUi: jest.fn().mockResolvedValue({
      id: 'maps-current',
      elements: [
        {
          path: [0],
          label: 'Search here',
          description: null,
          resourceId: 'example:id/search',
          className: 'android.widget.TextView',
          clickable: true,
          editable: false,
        },
      ],
    }),
    actUi: jest.fn().mockResolvedValue('issued'),
    closeUi: jest.fn().mockResolvedValue(undefined),
  };
}

function decisions(...responses: object[]) {
  const model = jest.fn<ReturnType<Model>, Parameters<Model>>();
  for (const response of responses) {
    model.mockResolvedValueOnce(JSON.stringify([response]));
  }
  return model;
}

test('reports the native timer result and prevents repeating dispatch', async () => {
  const tools = device();
  tools.startTimer.mockResolvedValue({ phase: 'ISSUED' });
  const model = decisions(
    { tool: 'start_timer', seconds: 90 },
    { tool: 'start_timer', seconds: 90 },
    { tool: 'finish', message: 'Sent a 90-second timer request to Clock.' },
  );

  await expect(runAgent('Set a 90-second timer', model, tools)).resolves.toBe(
    'Sent a 90-second timer request to Clock.',
  );
  expect(tools.startTimer).toHaveBeenCalledTimes(1);
  expect(tools.startTimer).toHaveBeenCalledWith(90);
  expect(model.mock.calls[1][1][2].content).toContain('ISSUED');
  expect(model.mock.calls[2][1][4].content).toContain('already invoked');
});

test('resolves each action against a fresh snapshot', async () => {
  const tools = device();
  tools.actUi.mockResolvedValueOnce('stale');
  const oldSnapshot = {
    id: 'maps-old',
    elements: [
      {
        path: [0],
        label: 'Search here',
        description: null,
        resourceId: 'example:id/search',
        className: 'android.widget.TextView',
        clickable: true,
        editable: false,
      },
    ],
  };
  tools.observeUi
    .mockResolvedValueOnce(oldSnapshot)
    .mockResolvedValueOnce(oldSnapshot);
  const click = { tool: 'click', match: { label: 'Search here' } };
  const model = decisions(
    { tool: 'open_app', packageName: 'com.google.android.apps.maps' },
    { tool: 'observe_ui' },
    click,
    { tool: 'observe_ui' },
    click,
    { tool: 'finish', message: 'Opened Maps search.' },
  );

  await expect(runAgent('Open Maps search', model, tools, true)).resolves.toBe(
    'Opened Maps search.',
  );
  expect(tools.openApp).toHaveBeenCalledWith('com.google.android.apps.maps');
  expect(tools.actUi.mock.calls).toEqual([
    ['maps-old', 0, 0, null],
    ['maps-current', 0, 0, null],
  ]);
  expect(model.mock.calls[3][1][6].content).toContain('screen changed');
  const observation = JSON.parse(model.mock.calls[2][1][4].content)
    .toolResults[0].result;
  expect(observation.elements[0]).toEqual({
    label: 'Search here',
    description: null,
    resourceId: 'search',
    clickable: true,
    editable: false,
  });
  expect(tools.closeUi).toHaveBeenCalledTimes(1);
});

test('screen sharing defaults off and keeps observations out of model input', async () => {
  const tools = device();
  const model = decisions(
    { tool: 'open_app', packageName: 'com.google.android.apps.maps' },
    { tool: 'observe_ui' },
    { tool: 'finish', message: 'Screen sharing is off.' },
  );

  await runAgent('Open Maps', model, tools);
  expect(tools.openApp).not.toHaveBeenCalled();
  expect(tools.observeUi).not.toHaveBeenCalled();
  expect(JSON.stringify(model.mock.calls[2][1])).not.toContain('Search here');
  expect(model.mock.calls[2][1][4].content).toContain('Screen sharing is off');
});

test('rejects invalid decisions before calling native tools and bounds retries', async () => {
  const tools = device();
  const model = jest
    .fn()
    .mockResolvedValue('[{"tool":"start_timer","seconds":0}]');

  await expect(runAgent('Set a timer', model, tools)).rejects.toThrow(
    'tool limit',
  );
  expect(model).toHaveBeenCalledTimes(18);
  expect(tools.startTimer).not.toHaveBeenCalled();
});

test('releases the foreground UI session after inference fails', async () => {
  const tools = device();
  const model = decisions({
    tool: 'open_app',
    packageName: 'com.google.android.apps.maps',
  });
  model.mockRejectedValueOnce(new Error('Companion disconnected.'));

  await expect(runAgent('Open Maps', model, tools, true)).rejects.toThrow(
    'disconnected',
  );
  expect(tools.closeUi).toHaveBeenCalledTimes(1);
});
