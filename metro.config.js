const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config =
  process.env.ANDROID_AGENT_INTEGRATION === '1'
    ? {
        resolver: {
          resolveRequest(context, moduleName, platform) {
            const entry =
              context.originModulePath === require.resolve('./index.js');
            return context.resolveRequest(
              context,
              entry && moduleName === './App'
                ? './integration/IntegrationApp'
                : moduleName,
              platform,
            );
          },
        },
      }
    : {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
