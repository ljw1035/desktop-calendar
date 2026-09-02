/**
 * 安全 IPC 桥
 * 把主进程能力暴露给渲染进程，但禁止直接访问 Node/Electron API
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  schedule: {
    list:    (year, month)         => ipcRenderer.invoke('schedule:list', { year, month }),
    byDate:  (date)                => ipcRenderer.invoke('schedule:listByDate', date),
    create:  (data)                => ipcRenderer.invoke('schedule:create', data),
    update:  (data)                => ipcRenderer.invoke('schedule:update', data),
    toggleDone: (id, occurrenceDate) => ipcRenderer.invoke('schedule:toggleDone', { id, occurrenceDate }),
    remove:  (id)                  => ipcRenderer.invoke('schedule:delete', id),
    // 通知点击时主进程推送：聚焦到指定日期+日程
    onFocus: (cb) => {
      const fn = (_e, date, scheduleId) => cb(date, scheduleId);
      ipcRenderer.on('schedule:focus', fn);
      return () => ipcRenderer.removeListener('schedule:focus', fn);
    },
  },
  todo: {
    list:    ()                    => ipcRenderer.invoke('todo:list'),
    create:  (content)             => ipcRenderer.invoke('todo:create', { content }),
    update:  (data)                => ipcRenderer.invoke('todo:update', data),
    remove:  (id)                  => ipcRenderer.invoke('todo:delete', id),
  },
  config: {
    get:     ()                    => ipcRenderer.invoke('config:get'),
    set:     (partial)             => ipcRenderer.invoke('config:set', partial),
    onChange: (cb)                 => {
      const fn = (_e, cfg) => cb(cfg);
      ipcRenderer.on('config:changed', fn);
      return () => ipcRenderer.removeListener('config:changed', fn);
    },
  },
  data: {
    // 数据变化通知：日程/待办被任意窗口改动后广播
    onChange: (cb) => {
      const fn = () => cb();
      ipcRenderer.on('data:changed', fn);
      return () => ipcRenderer.removeListener('data:changed', fn);
    },
  },
  window: {
    close:   ()                    => ipcRenderer.invoke('window:close'),
    hide:    ()                    => ipcRenderer.invoke('window:hide'),
    openSettings: ()               => ipcRenderer.invoke('window:openSettings'),
    toggleDevTools: ()             => ipcRenderer.invoke('window:toggleDevTools'),
  },
  resize: {
    // 无边框窗口边缘拖拽缩放（fire-and-forget，mousemove 高频）
    start: (edge, sx, sy) => ipcRenderer.send('widget:resizeStart', edge, sx, sy),
    move:  (sx, sy)       => ipcRenderer.send('widget:resizeMove', sx, sy),
    end:   ()             => ipcRenderer.send('widget:resizeEnd'),
  },
};

contextBridge.exposeInMainWorld('api', api);