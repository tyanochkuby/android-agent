import NativeTasks from '../src/native/NativeTasks';
import { openStationDirections } from '../src/mapsWorkflow';

jest.mock('../src/native/NativeTasks', () => ({
  __esModule: true,
  default: {
    startUi: jest.fn(),
    observeUi: jest.fn(),
    actUi: jest.fn(),
    stopUi: jest.fn(),
  },
}));

const observe = jest.mocked(NativeTasks.observeUi);
const act = jest.mocked(NativeTasks.actUi);
const stop = jest.mocked(NativeTasks.stopUi);

const element = (label: string, path: number[], options = {}) => ({
  label,
  path,
  className: null,
  resourceId: null,
  description: null,
  clickable: false,
  editable: false,
  ...options,
});

function snapshot(id: number, ...elements: ReturnType<typeof element>[]) {
  observe.mockResolvedValueOnce(JSON.stringify({ id: String(id), elements }));
}

beforeEach(() => {
  jest.clearAllMocks();
  act.mockResolvedValue('issued');
});

test('opens directions using snapshots and verifies the destination', async () => {
  snapshot(1, element('Search here', [0], { clickable: true }));
  snapshot(2, element('', [1], { editable: true }));
  snapshot(
    3,
    element('', [2], { clickable: true }),
    element('Warsaw Central Station', [2, 0]),
  );
  snapshot(4, element('Directions', [3], { clickable: true }));
  snapshot(
    5,
    element('Walking mode', [4]),
    element('Warsaw Central', [5], {
      description: 'Destination, Warsaw Central',
    }),
  );

  await expect(openStationDirections()).resolves.toBe('Warsaw Central');
  expect(act.mock.calls).toEqual([
    ['1', 0, 0, null],
    ['2', 0, 0, 'Warsaw Central Station'],
    ['3', 0, 1, null],
    ['4', 0, 0, null],
  ]);
  expect(stop).toHaveBeenCalledTimes(1);
});

test('ends the session when more than one distinct search target matches', async () => {
  snapshot(
    1,
    element('Search here', [0], { clickable: true }),
    element('Search here', [1], { clickable: true }),
  );

  await expect(openStationDirections()).rejects.toThrow(
    'More than one element matched.',
  );
  expect(act).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(1);
});

test('re-observes a stale target and stops on an action error', async () => {
  snapshot(1, element('Search here', [0], { clickable: true }));
  snapshot(2, element('Search here', [1], { clickable: true }));
  act
    .mockResolvedValueOnce('stale')
    .mockRejectedValueOnce(new Error('Session ended'));

  await expect(openStationDirections()).rejects.toThrow('Session ended');
  expect(act.mock.calls).toEqual([
    ['1', 0, 0, null],
    ['2', 0, 0, null],
  ]);
  expect(stop).toHaveBeenCalledTimes(1);
});
