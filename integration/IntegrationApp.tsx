import React, { useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { openStationDirections } from './mapsWorkflow';
import { actOn, runUiWorkflow, select } from '../src/uiWorkflow';

function checkFixture() {
  return runUiWorkflow('io.github.tyanochkuby.uifixture', async ui => {
    const field = () =>
      ui.waitFor(snapshot =>
        select(snapshot, element => element.editable, 'editable'),
      );
    await actOn(field, selection => ui.setText(selection, 'Central'));

    const result = () =>
      ui.waitFor(snapshot =>
        select(
          snapshot,
          element => element.label === 'Central Station',
          'clickable',
        ),
      );
    const stale = await result();
    await result();
    if ((await ui.click(stale)) !== 'stale') {
      throw new Error('An expired selection was accepted.');
    }
    await actOn(result, ui.click);
    await ui.waitFor(snapshot =>
      select(
        snapshot,
        element => element.label === 'Destination: Central Station',
      ),
    );

    await actOn(
      () =>
        ui.waitFor(snapshot =>
          select(
            snapshot,
            element => element.label === 'Open Settings',
            'clickable',
          ),
        ),
      ui.click,
    );
    try {
      await ui.waitFor(snapshot =>
        select(snapshot, element => element.label === 'Settings'),
      );
    } catch (error) {
      if (/session ended|lost the foreground/.test(String(error))) return;
      throw error;
    }
    throw new Error('The session could still read after switching apps.');
  });
}

export default function IntegrationApp() {
  const [status, setStatus] = useState('');
  async function run(work: () => Promise<unknown>) {
    setStatus('Running');
    try {
      await work();
      setStatus('Integration passed');
    } catch (error) {
      setStatus(`Integration failed: ${String(error)}`);
    }
  }

  return (
    <View style={styles.screen}>
      <Button title="Run fixture workflow" onPress={() => run(checkFixture)} />
      <Button
        title="Run Maps workflow"
        onPress={() => run(openStationDirections)}
      />
      <Text>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({ screen: { padding: 40 } });
