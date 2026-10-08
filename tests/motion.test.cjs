const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function sketch(permission = async () => 'granted', debug = false) {
  const elements = { shutter: { dataset: {}, setAttribute() {} }, 'lock-indicator': { dataset: {}, getBoundingClientRect: () => ({left: 136, top: 500, width: 128, height: 48}) }, 'shutter-label': {}, 'lock-icon': {}, intro: { classList: { add() {} } }, 'info-panel': {}, 'camera-controls': {}, 'info-open': {setAttribute() {}, focus() {}}, 'info-close': {focus() {}}, status: {} };
  const ctx = {
    URLSearchParams, Math, Number, String, performance: { now: () => 100 },
    window: { location: { search: '' }, isSecureContext: true,
      DeviceOrientationEvent: { requestPermission: permission },
      screen: { orientation: { angle: 0 } }, addEventListener() {} },
    document: { getElementById: id => elements[id] },
    width: 400, height: 800, deltaTime: 16,
    clearTimeout() {}, setTimeout() { return 1; }
  };
  vm.createContext(ctx);
  const source = fs.readFileSync('mySketch2.js', 'utf8');
  vm.runInContext(debug ? source.replace('const DEBUG_MODE = false;', 'const DEBUG_MODE = true;') : source, ctx);
  vm.runInContext('video = { elt: { readyState: 2, videoWidth: 720 } }; cursor = { x: 200, y: 400 }; target = { ...cursor };', ctx);
  ctx.read = expression => vm.runInContext(expression, ctx);
  ctx.elements = elements;
  ctx.toggleDrawing = async () => {
    await ctx.ensureTracking();
    if (ctx.read('orientationListening')) ctx.setShutterState('LOCKED');
  };
  return ctx;
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
test('relative pose, left/right, up/down, wrap and landscape', () => {
  const s = sketch();
  const pose = (alpha, beta, gamma) => s.orientationMatrix({ alpha, beta, gamma });
  const neutral = pose(0, 0, 0);
  near(s.relativeTilt(neutral, pose(0, 0, 15), 0).x, 15);
  near(s.relativeTilt(neutral, pose(0, 0, -15), 0).x, -15);
  near(s.relativeTilt(neutral, pose(0, 15, 0), 0).y, 15);
  near(s.relativeTilt(neutral, pose(0, -15, 0), 0).y, -15);
  near(s.relativeTilt(pose(123, 78, 24), pose(123, 78, 24), 0).x, 0);
  near(s.relativeTilt(pose(359, 90, 0), pose(1, 90, 0), 0).x, 2);
  near(s.relativeTilt(neutral, pose(0, -15, 0), 90).x, 15);
});
test('paused cursor keeps moving without stamps; resume preserves calibration and leaves a gap', async () => {
  let permissionCalls = 0;
  const s = sketch(async () => { permissionCalls++; return 'granted'; }, true);
  const stamps = [];
  s.stampVideo = (x, y) => stamps.push({ x, y });
  s.read('debugPanel = {}; debugCursor = { style: {} }');
  await s.toggleDrawing();
  s.handleOrientation({ alpha: 0, beta: 0, gamma: 0 });
  const neutral = s.read('neutralOrientation');
  s.handleOrientation({ alpha: 0, beta: 0, gamma: 20 });
  for (let i = 0; i < 100; i++) s.draw();
  assert.ok(stamps.at(-1).x < 200);
  s.pauseDrawing();
  const count = stamps.length;
  s.handleOrientation({ alpha: 0, beta: 0, gamma: -20 });
  for (let i = 0; i < 100; i++) s.draw();
  assert.equal(stamps.length, count);
  assert.ok(s.read('cursor.x > 200'));
  assert.equal(s.read('debugCursor.style.left'), `${s.read('cursor.x')}px`);
  assert.match(s.read('debugPanel.textContent'), /IDLE/);
  const currentX = s.read('cursor.x');
  const currentAngle = s.read('angle');
  const currentTarget = s.read('target.x');
  await s.toggleDrawing();
  near(s.read('cursor.x'), currentX);
  near(s.read('angle'), currentAngle);
  near(s.read('target.x'), currentTarget);
  assert.equal(s.read('neutralOrientation'), neutral);
  assert.equal(permissionCalls, 1);
  s.draw();
  assert.equal(stamps.length, count + 1);
  assert.ok(stamps.at(-1).x > 200);
  assert.ok(Math.abs(stamps.at(-1).x - currentX) < .001);
});
test('null readings do not calibrate and extreme tilt is bounded', async () => {
  const s = sketch(); await s.toggleDrawing();
  s.handleOrientation({ alpha: null, beta: null, gamma: null });
  assert.equal(s.read('neutralOrientation'), null);
  s.handleOrientation({ alpha: 0, beta: 0, gamma: 0 });
  s.handleOrientation({ alpha: 0, beta: 0, gamma: 80 });
  near(s.read('target.x'), 0);
});
test('permission denial and released initialization do not start drawing', async () => {
  const denied = sketch(async () => 'denied'); await denied.toggleDrawing();
  assert.equal(denied.read('isDrawing'), false);
  let resolve;
  const delayed = sketch(() => new Promise(done => { resolve = done; }));
  const pending = delayed.ensureTracking();
  delayed.pauseDrawing(); resolve('granted'); await pending;
  assert.equal(delayed.read('isDrawing'), false);
  assert.equal(delayed.read('orientationListening'), true);
});

test('upright heading and pitch move the cursor without rotating the fragment', async () => {
  const s = sketch(); await s.toggleDrawing();
  s.handleOrientation({ alpha: 0, beta: 90, gamma: 0 });
  s.handleOrientation({ alpha: 20, beta: 90, gamma: 0 });
  assert.ok(s.read('target.x < 200'));
  near(s.read('targetAngle'), 0);
  s.handleOrientation({ alpha: 0, beta: 70, gamma: 0 });
  assert.ok(s.read('target.y > 400'));
  near(s.read('targetAngle'), 0);
});

function rolledMatrix(s, degrees, heading = 0, pitch = 90) {
  const m = s.orientationMatrix({ alpha: heading, beta: pitch, gamma: 0 });
  const r = -degrees * Math.PI / 180, c = Math.cos(r), n = Math.sin(r);
  // Physical roll around the phone's screen normal, not around world vertical.
  return [0, 3, 6].flatMap(i => [m[i] * c + m[i+1] * n,
    -m[i] * n + m[i+1] * c, m[i+2]]);
}

test('screen roll has correct sign, neutral offset, wrap, clamp, and flat-pose fallback', () => {
  const s = sketch();
  for (const heading of [0, 80, 240]) {
    for (const pitch of [60, 90, 120]) {
      for (const roll of [-30, -15, 0, 15, 30]) {
        near(s.screenRoll(rolledMatrix(s, roll, heading, pitch), 0), roll);
      }
    }
  }
  near(s.screenRoll(rolledMatrix(s, 90), 90), 0);
  near(s.screenRoll(rolledMatrix(s, 105), 90), 15);
  s.updatePhoneRoll(rolledMatrix(s, 10), 0);
  s.updatePhoneRoll(rolledMatrix(s, 25), 0);
  near(s.read('relativeRoll'), 15);
  near(s.read('targetAngle'), Math.PI / 12);
  s.updatePhoneRoll(rolledMatrix(s, 80), 0);
  near(s.read('targetAngle'), Math.PI / 4);
  s.updatePhoneRoll(rolledMatrix(s, 0, 0, 0), 0);
  assert.equal(s.read('rawRoll'), null);
  near(s.read('targetAngle'), Math.PI / 4);
  s.read('neutralRoll = 179');
  s.updatePhoneRoll(rolledMatrix(s, -179), 0);
  near(s.read('relativeRoll'), 2);
});

test('roll tracks during pause and resume retains neutral and current rotation', async () => {
  const s = sketch(); await s.toggleDrawing();
  s.handleOrientation({ alpha: 0, beta: 90, gamma: 0 });
  const neutral = s.read('neutralRoll');
  s.pauseDrawing();
  // Equivalent Euler representation of upright +30° physical roll.
  s.handleOrientation({ alpha: -90, beta: 60, gamma: 90 });
  near(s.read('target.x'), 200); near(s.read('target.y'), 400);
  for (let i = 0; i < 200; i++) s.draw();
  near(s.read('angle'), Math.PI / 6);
  const pausedAngle = s.read('angle');
  await s.toggleDrawing();
  near(s.read('angle'), pausedAngle);
  near(s.read('neutralRoll'), neutral);
  s.read('drawStampAt = () => {}');
  for (let i = 0; i < 100; i++) s.stampVideo(200, 400, 160);
  near(s.read('angle'), pausedAngle);
  s.handleOrientation({ alpha: 0, beta: 90, gamma: 0 });
  for (let i = 0; i < 200; i++) s.updateMotionCursor();
  near(s.read('angle'), 0);
});
test('stamps draw from the native camera at the requested size', () => {
  const s = sketch(); let args;
  s.push = s.pop = s.translate = s.rotate = () => {};
  s.drawingContext = { drawImage(...values) { args = values; } };
  s.read('video.elt.videoWidth = 1920; video.elt.videoHeight = 1080');
  s.drawStampAt(200, 400, 160);
  assert.equal(args[0], s.read('video.elt'));
  assert.deepEqual(args.slice(1), [240, 0, 1440, 1080, -80, -60, 160, 120]);
  assert.equal(s.drawingContext.imageSmoothingQuality, 'high');
  assert.equal(s.read('debugEnabled'), false);
});

test('vertical mapping and smoothing continue while paused', async () => {
  const s = sketch(); await s.toggleDrawing();
  s.handleOrientation({ alpha: 0, beta: 0, gamma: 0 });
  s.handleOrientation({ alpha: 0, beta: 15, gamma: 0 });
  assert.ok(s.read('target.y < 400'));
  s.handleOrientation({ alpha: 0, beta: -15, gamma: 0 });
  assert.ok(s.read('target.y > 400'));
  s.pauseDrawing();
  s.draw();
  assert.ok(s.read('cursor.y > 400 && cursor.y < target.y'));
  s.handleOrientation({ alpha: 0, beta: 15, gamma: 0 });
  for (let i = 0; i < 100; i++) s.draw();
  assert.ok(s.read('cursor.y < 400'));
  assert.ok(s.read('Math.abs(cursor.y - target.y)') < .001);
});

test('intensity maps slow/normal/fast to bounded sizes', () => {
  const s = sketch();
  near(s.intensityToScale(0), 1.5);
  near(s.intensityToScale(1.5), 1);
  near(s.intensityToScale(4), .6);
  near(s.intensityToScale(100), .6);
});

test('motion smoothing suppresses spikes and footfalls, and stale data restores default', () => {
  const s = sketch(); let now = 0;
  s.performance.now = () => now;
  const sample = (value, dt = 16) => {
    now += dt;
    s.handleDeviceMotion({ acceleration: { x: value, y: 0, z: 0 } });
    s.updateFragmentSize();
  };
  for (let i = 0; i < 1000; i++) sample(1.5);
  near(s.read('sizeScale'), 1);
  sample(1000);
  assert.ok(Math.abs(s.read('sizeScale') - 1) < .001);
  assert.equal(s.read('rawMotionIntensity'), 1000);
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < 1000; i++) {
    sample(i % 32 < 16 ? 0 : 3);
    if (i > 700) {
      low = Math.min(low, s.read('sizeScale'));
      high = Math.max(high, s.read('sizeScale'));
    }
  }
  assert.ok(high - low < .03);
  for (let i = 0; i < 1000; i++) sample(0);
  assert.ok(s.read('sizeScale') > 1.49);
  for (let i = 0; i < 1000; i++) sample(5);
  assert.ok(s.read('sizeScale') < .61);
  now += 2000;
  for (let i = 0; i < 500; i++) s.updateFragmentSize();
  assert.ok(Math.abs(s.read('sizeScale') - 1) < .001);
});

test('gravity fallback ignores static tilt and invalid readings', () => {
  const s = sketch(); let now = 0; s.performance.now = () => now;
  for (let i = 0; i < 1000; i++) {
    now += 16;
    const radians = i / 100;
    s.handleDeviceMotion({ accelerationIncludingGravity: {
      x: 9.81 * Math.sin(radians), y: 0, z: 9.81 * Math.cos(radians)
    } });
  }
  assert.ok(s.read('smoothedMotionIntensity') < .01);
  const before = s.read('lastMotionAt');
  s.handleDeviceMotion({ acceleration: { x: null, y: NaN, z: 0 } });
  assert.equal(s.read('lastMotionAt'), before);
});

test('motion permission is requested from DRAW; denial preserves orientation drawing', async () => {
  const s = sketch(); let calls = 0;
  s.window.DeviceMotionEvent = { requestPermission() { calls++; return Promise.resolve('denied'); } };
  await s.toggleDrawing();
  assert.equal(calls, 1);
  assert.equal(s.read('orientationListening'), true);
  assert.equal(s.read('isDrawing'), true);
  near(s.read('sizeScale'), 1);
});

test('reversing slightly after sustained edge overshoot releases all four boundaries', async () => {
  for (const axis of ['x', 'y']) {
    for (const sign of [-1, 1]) {
      const s = sketch(); await s.toggleDrawing();
      const pose = value => ({ alpha: 0, beta: axis === 'y' ? value : 0, gamma: axis === 'x' ? value : 0 });
      s.handleOrientation(pose(0));
      s.pauseDrawing();
      for (let value = 1; value <= 80; value++) {
        s.handleOrientation(pose(sign * value));
        s.draw();
      }
      for (let i = 0; i < 100; i++) s.draw();
      const limit = axis === 'x' ? 400 : 800;
      const edge = sign > 0 ? 0 : limit;
      near(s.read(`target.${axis}`), edge);
      const before = s.read(`cursor.${axis}`);
      await s.toggleDrawing();
      s.handleOrientation(pose(sign * 79));
      const target = s.read(`target.${axis}`);
      assert.ok(target > 0 && target < limit, `${axis}: reversal remained pinned at ${target}`);
      s.updateMotionCursor();
      assert.ok(sign > 0 ? s.read(`cursor.${axis}`) > before : s.read(`cursor.${axis}`) < before);
    }
  }
});

test('size sensor updates cannot mutate cursor, calibration, or edge mapping', async () => {
  const s = sketch(); await s.toggleDrawing();
  s.handleOrientation({ alpha: 0, beta: 0, gamma: 0 });
  s.handleOrientation({ alpha: 0, beta: 0, gamma: -80 });
  const snapshot = () => s.read('JSON.stringify({cursor,target,strokeOrigin,neutralOrientation,angle,targetAngle})');
  const before = snapshot();
  let now = 0; s.performance.now = () => now;
  for (let i = 0; i < 500; i++) {
    now += 16;
    s.handleDeviceMotion({ acceleration: { x: 8, y: 4, z: 2 } });
    s.updateFragmentSize();
  }
  assert.equal(snapshot(), before);
  assert.ok(s.read('sizeScale') < 1);
});

async function shutterSketch() {
  const s = sketch(); let now = 100; const stamps = [];
  s.performance.now = () => now;
  await s.ensureTracking();
  s.handleOrientation({alpha: 0, beta: 90, gamma: 0});
  s.stampVideo = (x, y, size) => stamps.push({x, y, size});
  const button = {setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {}};
  const event = (extra = {}) => ({pointerId: 1, button: 0, isPrimary: true,
    clientX: 200, clientY: 620, currentTarget: button, preventDefault() {}, ...extra});
  return {s, stamps, event, time: value => { now = value; }};
}

test('tap stamps immediately exactly once, and release does not stamp again', async () => {
  const {s, stamps, event, time} = await shutterSketch();
  s.shutterDown(event()); assert.equal(stamps.length, 1);
  time(150); for (let i = 0; i < 10; i++) s.draw();
  s.shutterUp(event()); time(400); s.draw();
  assert.equal(stamps.length, 1); assert.equal(s.read('shutterState'), 'IDLE');
});

test('hold draws continuously after initial stamp and stops on release outside', async () => {
  const {s, stamps, event, time} = await shutterSketch();
  s.shutterDown(event()); time(300); s.draw(); s.draw();
  assert.equal(stamps.length, 3);
  s.shutterMove(event({clientX: 0, clientY: 520}));
  assert.equal(s.read('shutterState'), 'PRESSING');
  s.shutterUp(event({clientX: 0, clientY: 520})); s.draw();
  assert.equal(stamps.length, 3);
});

test('lock survives release and cancellation; STOP does not stamp', async () => {
  const {s, stamps, event} = await shutterSketch();
  s.shutterDown(event());
  s.shutterMove(event({clientY: 524}));
  assert.equal(s.read('shutterState'), 'LOCKED');
  s.shutterCancel(event()); s.draw();
  assert.equal(stamps.length, 2);
  s.shutterDown(event()); s.shutterUp(event()); s.draw();
  assert.equal(stamps.length, 2);
  assert.equal(s.read('shutterState'), 'IDLE');
});

test('secondary pointer cannot stamp, unlock, or interrupt active press; cancel stops hold', async () => {
  const {s, stamps, event, time} = await shutterSketch();
  s.shutterDown(event());
  s.shutterDown(event({pointerId: 2, isPrimary: false}));
  s.shutterMove(event({pointerId: 2, clientY: 524}));
  s.shutterUp(event({pointerId: 2}));
  assert.equal(stamps.length, 1); assert.equal(s.read('shutterState'), 'PRESSING');
  s.shutterCancel(event()); time(400); s.draw();
  assert.equal(stamps.length, 1); assert.equal(s.read('shutterState'), 'IDLE');
});


test('information panel suspends locked stamps and interactions without resetting motion', async () => {
  const {s, stamps, event} = await shutterSketch();
  s.shutterDown(event()); s.shutterMove(event({clientY: 524})); s.shutterUp(event());
  assert.equal(s.read('shutterState'), 'LOCKED');
  const neutral = s.read('neutralOrientation');
  s.openInformation();
  const count = stamps.length;
  s.handleOrientation({alpha: 15, beta: 90, gamma: 0});
  for (let i = 0; i < 20; i++) s.draw();
  s.shutterDown(event());
  assert.equal(stamps.length, count);
  assert.equal(s.read('shutterState'), 'LOCKED');
  assert.ok(s.read('cursor.x < 200'));
  assert.equal(s.elements['camera-controls'].inert, true);
  s.closeInformation(); s.draw();
  assert.equal(stamps.length, count + 1);
  assert.equal(s.read('neutralOrientation'), neutral);
});

test('intro fades only on first successful stamp and stays hidden after clear', async () => {
  const {s, event} = await shutterSketch(); let fades = 0;
  s.elements.intro.classList.add = value => { assert.equal(value, 'dismissed'); fades++; };
  s.openInformation(); assert.equal(s.stampCurrentFragment(), false);
  assert.equal(fades, 0); s.closeInformation();
  s.shutterDown(event()); s.shutterUp(event()); assert.equal(fades, 1);
  s.background = value => assert.equal(value, 0);
  s.resetCanvas(); s.shutterDown(event()); s.shutterUp(event());
  assert.equal(fades, 1);
});
