/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { voiceTurn } from './src/voice';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
// Started by the assistant service with a final transcript, with or without the Activity.
AppRegistry.registerHeadlessTask('VoiceTurn', () => voiceTurn);
