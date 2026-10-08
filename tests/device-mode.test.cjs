const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function classify(ua, touch = 0, capable = true, coarse = true) {
  const context = {
    navigator: {userAgent: ua, maxTouchPoints: touch, mediaDevices: capable ? {getUserMedia(){}} : undefined},
    window: {matchMedia: () => ({matches: coarse}), ...(capable ? {DeviceOrientationEvent: function(){}} : {})},
    document: {documentElement: {dataset: {}}}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('device-mode.js','utf8'),context);
  return context.window.footageMobile;
}
test('desktop and touchscreen laptops stay desktop regardless of narrow viewport', () => {
  for (const ua of ['Windows NT 10.0', 'Macintosh; Intel Mac OS X', 'X11; Linux x86_64', 'CrOS']) {
    assert.equal(classify(ua, ua.includes('Windows') ? 10 : 0), false);
  }
});
test('phones and capable tablets route to mobile, including desktop-UA iPadOS', () => {
  for (const ua of ['iPhone', 'Android Mobile', 'iPad', 'Android Tablet', 'Macintosh; Intel Mac OS X']) {
    assert.equal(classify(ua, 5), true);
  }
  assert.equal(classify('Android Tablet', 5, false), false);
  assert.equal(classify('iPhone', 5, false), true);
  assert.equal(classify('Unknown', 5), true);
  assert.equal(classify('Unknown', 5, true, false), false);
});
test('desktop setup stops before any canvas, UI handlers, or sensor initialization', () => {
  const calls = [];
  const context = {window: {footageMobile:false}, noCanvas:()=>calls.push('noCanvas'), noLoop:()=>calls.push('noLoop')};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('mySketch2.js','utf8'), context);
  context.setup(); context.draw();
  assert.deepEqual(calls,['noCanvas','noLoop']);
});
