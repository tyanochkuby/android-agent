module.exports = {
  preset: '@react-native/jest-preset',
  testTimeout: 15_000,
  haste: {
    defaultPlatform: 'android',
    platforms: ['android', 'ios', 'native'],
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|react-native-safe-area-context|@react-native(-community)?)/)',
  ],
};
