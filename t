// native-fs-binding.test.mjs
const { test, expect } = require('jstest');

test('test bind workspace', async () => {
    const foundation = new Foundation();
    const path = '/path/to/workspace';
    await foundation.bindWorkspace(path);
    expect(foundation.workspaceBound).toBe(true);
});

test('test cancel picker', async () => {
    const foundation = new Foundation();
    await foundation.cancelPicker();
    expect(foundation.pickerCancelled).toBe(true);
});