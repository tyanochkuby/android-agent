import {
  contextBudget,
  fallbackContextTokens,
  instructions,
  requestSize,
  runAgent,
} from '../src/agent';
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
  expect(model.mock.calls[3][1][7].content).toContain('screen changed');
  const observation = JSON.parse(model.mock.calls[2][1][5].content)
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
  expect(model.mock.calls[0]).toEqual([
    instructions,
    [{ role: 'user', content: 'Open Maps' }],
  ]);
  expect(instructions).toContain('Screen sharing is off unless');
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

test('screen sharing adds its tools after the prompt for that request only', async () => {
  const model = decisions({ tool: 'finish', message: 'Done.' });
  const history = [
    { role: 'user' as const, content: 'Earlier' },
    { role: 'assistant' as const, content: 'Reply' },
  ];

  await runAgent('Open Maps', model, device(), true, history);
  const input = model.mock.calls[0][1];
  expect(input.slice(0, 3)).toEqual([
    ...history,
    { role: 'user', content: 'Open Maps' },
  ]);
  expect(input[3].content).toMatch(/^Screen sharing is on for this request/);
  expect(input).toHaveLength(4);
});

test('does not call the model when the current request alone is over the limit', async () => {
  const model = decisions({ tool: 'finish', message: 'Done.' });
  const limit = {
    ...contextBudget(null),
    requestTokens: requestSize([{ role: 'user', content: 'Hi' }]).tokens,
  };

  await expect(
    runAgent('Hello', model, device(), false, [], limit),
  ).rejects.toThrow('too large to send');
  expect(model).not.toHaveBeenCalled();
});

test('stops before a model call once tool results push the request over the limit', async () => {
  const tools = device();
  tools.startTimer.mockResolvedValue({ phase: 'ISSUED' });
  const model = decisions(
    { tool: 'start_timer', seconds: 90 },
    { tool: 'finish', message: 'Done.' },
  );
  const limit = {
    ...contextBudget(null),
    requestTokens: requestSize([{ role: 'user', content: 'Set a timer' }])
      .tokens,
  };

  await expect(
    runAgent('Set a timer', model, tools, false, [], limit),
  ).rejects.toThrow('Check the device for any actions already taken');
  expect(model).toHaveBeenCalledTimes(1);
  expect(tools.startTimer).toHaveBeenCalledTimes(1);
});

test('budgets an unreported context window as the small fallback', () => {
  const unknown = contextBudget(null);
  expect(unknown.requestTokens).toBe(fallbackContextTokens * 0.75);
  expect(unknown.historyTokens).toBeLessThan(unknown.requestTokens);
  expect(unknown.compactAt).toBeLessThan(unknown.historyTokens);

  const large = contextBudget(400_000);
  // Output and the current turn stay reserved; history compacts before it fills its share.
  expect(large.requestTokens).toBe(368_000);
  expect(large.historyTokens).toBe(276_000);
  expect(large.compactAt).toBe(220_800);
});

test('estimates tokens from UTF-8 bytes, so non-Latin text counts higher', () => {
  const ascii = requestSize([{ role: 'user', content: 'a'.repeat(300) }]);
  const cjk = requestSize([{ role: 'user', content: '字'.repeat(300) }]);
  expect(cjk.bytes - ascii.bytes).toBe(600);
  expect(cjk.tokens - ascii.tokens).toBe(200);
});
