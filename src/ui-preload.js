'use strict';
// The bridge for the app's own screens (start screen, menu, dialogs, toast). Never loaded into web pages.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tv', {
  onRender: (fn) => ipcRenderer.on('ui:render', (_e, state) => fn(state)),
  onKey: (fn) => ipcRenderer.on('ui:key', (_e, key) => fn(key)),
  onInsert: (fn) => ipcRenderer.on('ui:insert', (_e, text) => fn(text)),
  onToast: (fn) => ipcRenderer.on('ui:toast', (_e, text) => fn(text)),
  act: (layer, index, extra) => ipcRenderer.send('ui:act', layer, index, extra),
  back: () => ipcRenderer.send('ui:back'),
});
