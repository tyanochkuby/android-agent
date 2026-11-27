import {
  contextBudget,
  fallbackContextTokens,
  instructions,
  requestSize,
  runAgent,
} from '../src/agent';
import type { AgentTools, Model, Screenshot } from '../src/agent';

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
    captureUi: jest.fn<ReturnType<AgentTools['captureUi']>, []>(),
    listScreenshots: jest.fn<Promise<Screenshot[]>, []>().mockResolvedValue([]),
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

test('screen tools are always advertised and explain how to turn sharing on', async () => {
  const tools = device();
  const model = decisions(
    { tool: 'open_app', packageName: 'com.google.android.apps.maps' },
    { tool: 'get_screen' },
    { tool: 'list_screenshots' },
    { tool: 'finish', message: 'Screen sharing is off.' },
  );

  await runAgent('Open Maps', model, tools);
  expect(model.mock.calls[0]).toEqual([
    instructions,
    [{ role: 'user', content: 'Open Maps' }],
  ]);
  expect(instructions).toContain('{"tool":"get_screen"}');
  expect(tools.openApp).not.toHaveBeenCalled();
  expect(tools.captureUi).not.toHaveBeenCalled();
  expect(tools.listScreenshots).not.toHaveBeenCalled();
  expect(model.mock.calls[3][1][6].content).toContain(
    'Turn on Share screen with the agent',
  );
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

test('screen sharing keeps the prompt prefix unchanged', async () => {
  const model = decisions({ tool: 'finish', message: 'Done.' });
  const history = [
    { role: 'user' as const, content: 'Earlier' },
    { role: 'assistant' as const, content: 'Reply' },
  ];

  await runAgent('Open Maps', model, device(), true, history);
  expect(model.mock.calls[0]).toEqual([
    instructions,
    [...history, { role: 'user', content: 'Open Maps' }],
  ]);
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

function screenOf(id: string, label: string, clickable = false) {
  return {
    id,
    elements: [
      {
        path: [0],
        label,
        description: label,
        resourceId: null,
        className: 'android.widget.TextView',
        clickable,
        editable: false,
      },
    ],
  };
}

test('reads the source app, switches apps and keeps its latest observation', async () => {
  const tools = { ...device(), report: jest.fn() };
  const description = `FAV TRACKS: TOGETHER, ${'I GIVE EVERYTHING '.repeat(
    20,
  )}`;
  tools.observeUi
    .mockResolvedValueOnce(screenOf('video', description))
    .mockResolvedValueOnce(screenOf('music-1', 'Library'))
    .mockResolvedValueOnce(screenOf('music-2', 'Create playlist', true));
  const model = decisions(
    { tool: 'observe_ui' },
    { tool: 'open_app', packageName: 'com.example.music' },
    { tool: 'observe_ui' },
    { tool: 'observe_ui' },
    { tool: 'finish', message: 'Ready to create the playlist.' },
  );

  await expect(
    runAgent('Make a playlist from this video', model, tools, {
      source: 'com.example.video',
    }),
  ).resolves.toBe('Ready to create the playlist.');

  expect(model.mock.calls[0][1][1].content).toContain(
    'The user asked while com.example.video was in front.',
  );
  expect(tools.openApp.mock.calls).toEqual([
    ['com.example.video'],
    ['com.example.music'],
  ]);
  expect(tools.closeUi).toHaveBeenCalledTimes(2);
  const last = JSON.stringify(model.mock.calls[4][1]);
  // Long text arrives whole, once, and survives the switch; only the music app's older screen is dropped.
  expect(last.split(description)).toHaveLength(2);
  expect(last).not.toContain('"Library"');
  expect(last).toContain('Create playlist');
  expect(tools.report).toHaveBeenCalledWith({ attempted: 4, failed: 0 });
});

test('a typed request cannot switch apps', async () => {
  const tools = device();
  const model = decisions(
    { tool: 'open_app', packageName: 'com.google.android.apps.maps' },
    { tool: 'open_app', packageName: 'com.example.other' },
    { tool: 'finish', message: 'Stayed in Maps.' },
  );

  await runAgent('Open Maps', model, tools, true);
  expect(tools.openApp).toHaveBeenCalledTimes(1);
  expect(model.mock.calls[2][1][4].content).toContain('already open');
});

test('refuses a repeated failing call on an unchanged screen', async () => {
  const tools = { ...device(), report: jest.fn() };
  const click = { tool: 'click', match: { label: 'Missing' } };
  const model = decisions(
    { tool: 'open_app', packageName: 'com.google.android.apps.maps' },
    click,
    click,
    { tool: 'observe_ui' },
    click,
    { tool: 'finish', message: 'Could not find it.' },
  );

  await runAgent('Click Missing', model, tools, true);
  expect(model.mock.calls[2][1][4].content).toContain('No matching control');
  expect(model.mock.calls[3][1][6].content).toContain('was not run again');
  // The unchanged observation keeps the refusal in place.
  expect(model.mock.calls[5][1][10].content).toContain('was not run again');
  expect(tools.actUi).not.toHaveBeenCalled();
  expect(tools.report).toHaveBeenCalledWith({ attempted: 3, failed: 3 });
});

test('stops after repeated failed calls', async () => {
  const tools = device();
  const model = jest
    .fn()
    .mockImplementation(async () =>
      JSON.stringify([{ tool: 'click', match: { label: `${Math.random()}` } }]),
    );

  await expect(runAgent('Click', model, tools, true)).rejects.toThrow(
    'repeated failed calls',
  );
  expect(model).toHaveBeenCalledTimes(6);
});

function shot(id: string): Screenshot {
  return { id, app: 'com.example.video', capturedAt: '2026-11-27T10:00:00Z' };
}

test('attaches the latest screenshot only and reads kept ones by ID', async () => {
  const tools = device();
  const first = shot('s-20261127-100000-aaaaaa');
  const second = shot('s-20261127-100100-bbbbbb');
  tools.captureUi
    .mockResolvedValueOnce({ screenshot: first, snapshot: screenOf('a', 'Song') })
    .mockResolvedValueOnce({ screenshot: second, snapshot: screenOf('b', 'Next') });
  tools.listScreenshots.mockResolvedValue([second, first]);
  const model = Object.assign(
    decisions(
      { tool: 'get_screen' },
      { tool: 'get_screen' },
      { tool: 'read_screenshot', id: first.id },
      { tool: 'finish', message: 'Compared both.' },
    ),
    { images: true },
  );

  await expect(
    runAgent('Compare', model, tools, { source: 'com.example.video' }),
  ).resolves.toBe('Compared both.');

  const attached = (call: number) =>
    model.mock.calls[call][1]
      .map(message => message.screenshot)
      .filter(Boolean);
  expect(attached(1)).toEqual([first.id]);
  expect(attached(2)).toEqual([second.id]);
  expect(attached(3)).toEqual([first.id]);
  const input = JSON.stringify(model.mock.calls[3][1]);
  expect(input).toContain('Earlier image omitted');
  expect(requestSize(model.mock.calls[3][1]).tokens).toBeGreaterThan(1_600);
});

test('reports a missing kept screenshot and text-only connections', async () => {
  const tools = device();
  tools.captureUi.mockResolvedValue({
    screenshot: shot('s-20261127-100000-aaaaaa'),
    snapshot: screenOf('a', 'Song'),
  });
  const model = decisions(
    { tool: 'get_screen' },
    { tool: 'read_screenshot', id: 's-20261127-100000-zzzzzz' },
    { tool: 'finish', message: 'Done.' },
  );

  await runAgent('Look', model, tools, { source: 'com.example.video' });
  const input = model.mock.calls[2][1];
  expect(input.some(message => message.screenshot)).toBe(false);
  expect(input[3].content).toContain('Images are not supported');
  expect(input[3].content).toContain('Song');
  expect(input[5].content).toContain('No kept screenshot has this ID.');
});
