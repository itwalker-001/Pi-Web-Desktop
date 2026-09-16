'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  proxy: { enabled: false, url: '' },
  registry: '',
  port: 30141,
  autoStart: true,
};

let cached = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cached) return cached;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {}
  cached = {
    ...DEFAULTS,
    ...data,
    proxy: { ...DEFAULTS.proxy, ...(data && data.proxy ? data.proxy : {}) },
  };
  return cached;
}

function save(patch) {
  const prev = load();
  const next = {
    ...prev,
    ...patch,
    proxy: { ...prev.proxy, ...((patch && patch.proxy) || {}) },
  };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return next;
}

function get() {
  return load();
}

module.exports = { get, save, DEFAULTS };
