const DEBUG_MODE = false; // Set to true and reload to show debug visuals.

let infoOpen = false;
let hasCaptured = false;

let video;
let canvas;
let isDrawing = false;
let cameraStarting = false;
let cameraTimer;
let angle = 0;
let targetAngle = 0;
let rawRoll = null;
let neutralRoll = null;
let relativeRoll = 0;
const rollSettings = { maxDegrees: 45, smoothingMs: 90 };

// Development tuning: ±30° reaches an edge; 90ms filtering softens hand tremor.
const motionSettings = { range: 30, smoothingMs: 90, stampSize: 160 };
// Relative acceleration intensity (m/s²), not integrated walking velocity.
const sizingSettings = {
  slow: 0.25, normal: 1.5, fast: 4,
  minScale: 0.6, maxScale: 1.5, spikeLimit: 8,
  envelopeMs: 350, smoothingMs: 2500, sizeSmoothingMs: 500
};
let rawMotionIntensity = null;
let smoothedMotionIntensity = sizingSettings.normal;
let motionEnvelope = sizingSettings.normal;
let lastMotionAt = null;
let gravityMagnitude = null;
let sizeScale = 1;
let motionSource = "unavailable — default size";
const debugEnabled = DEBUG_MODE;
let debugPanel, debugCursor;
let rawOrientation = null;
let neutralOrientation = null;
let cursor = { x: 0, y: 0 };
let target = { x: 0, y: 0 };
let strokeOrigin = { x: 0, y: 0 };
let orientationDelta = { x: 0, y: 0 };
let edgeOverflow = { x: 0, y: 0 };
let orientationListening = false;
let trackingRequest = null;
let shutterState = "IDLE";
let activePointer = null;
let pressStartedAt = 0;
let pressStamped = false;
let lockCenter = null;
const TAP_WINDOW_MS = 180;
let sensorTimer;
let lastSensorAt = 0;

function setup() {
  const host = document.getElementById("canvas-host");
  // Match the phone display instead of stretching a 1x canvas on Retina screens.
  pixelDensity(window.devicePixelRatio || 1);
  canvas = createCanvas(host.clientWidth, host.clientHeight);
  canvas.parent(host);
  canvas.elt.setAttribute("aria-label", "Accumulated live camera fragments");
  background(0);
  imageMode(CENTER);
  angleMode(RADIANS);

  setupShutter();
  setupInformation();
  document.getElementById("clear").addEventListener("click", resetCanvas);
  document.getElementById("save").addEventListener("click", () => {
    // Save this canvas's pixels, without redrawing or including the UI.
    saveCanvas(canvas, `footage-${Date.now()}`, "png");
  });
  new ResizeObserver(windowResized).observe(host);
  cursor = { x: width / 2, y: height / 2 };
  target = { ...cursor };
  if (debugEnabled) {
    debugPanel = document.createElement("pre");
    debugPanel.id = "motion-debug";
    debugCursor = document.createElement("div");
    debugCursor.id = "motion-cursor";
    debugCursor.setAttribute("aria-hidden", "true");
    document.body.append(debugPanel, debugCursor);
  }
  window.addEventListener("orientationchange", recalibrateMotion);
  window.screen?.orientation?.addEventListener("change", recalibrateMotion);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isDrawing) pauseDrawing();
  });
}

function setStatus(message) {
  // Keep routine interaction hints out of the minimal UI; retain error/readiness messages.
  const routine = ["Tap to capture · hold to draw", "Drawing locked. Tap STOP to finish."];
  document.getElementById("status").textContent = routine.includes(message) ? "" : message;
}

function setupInformation() {
  document.getElementById("info-open").addEventListener("click", openInformation);
  document.getElementById("info-close").addEventListener("click", closeInformation);
  document.getElementById("info-panel").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeInformation(); }
    if (event.key === "Tab") {
      // The close button is now the panel's only interactive element.
      event.preventDefault();
      document.getElementById("info-close").focus();
    }
  });
}

function openInformation() {
  if (infoOpen) return;
  infoOpen = true;
  // A physical hold cannot survive a dialog; an existing lock is suspended intact.
  if (shutterState === "PRESSING") pauseDrawing();
  activePointer = null;
  document.getElementById("info-panel").hidden = false;
  document.getElementById("camera-controls").inert = true;
  document.getElementById("info-open").setAttribute("aria-expanded", "true");
  document.getElementById("info-close").focus();
}

function closeInformation() {
  if (!infoOpen) return;
  document.getElementById("info-panel").hidden = true;
  document.getElementById("camera-controls").inert = false;
  document.getElementById("info-open").setAttribute("aria-expanded", "false");
  document.getElementById("info-open").focus();
  infoOpen = false;
}

function setupShutter() {
  const button = document.getElementById("shutter");
  button.addEventListener("pointerdown", shutterDown);
  button.addEventListener("pointermove", shutterMove);
  button.addEventListener("pointerup", shutterUp);
  button.addEventListener("pointercancel", shutterCancel);
  button.addEventListener("lostpointercapture", shutterCancel);
  button.addEventListener("contextmenu", event => event.preventDefault());
  // Pointer events own physical gestures. Only synthetic/keyboard clicks use click.
  button.addEventListener("click", event => {
    event.preventDefault();
    if (infoOpen || event.detail !== 0 || activePointer !== null) return;
    if (shutterState === "LOCKED") pauseDrawing();
    else if (canStamp()) stampCurrentFragment();
    else { ensureTracking(); setStatus("Preparing camera and motion. Tap again when ready."); }
  });
  window.addEventListener("blur", pauseDrawing);
  updateDrawControl();
}

function setShutterState(state) {
  shutterState = state;
  isDrawing = state !== "IDLE";
  updateDrawControl();
}

function shutterDown(event) {
  if (infoOpen || event.isPrimary === false || event.button !== 0 || activePointer !== null) return;
  event.preventDefault();
  if (shutterState === "LOCKED") { pauseDrawing(); return; }
  if (!canStamp()) {
    ensureTracking();
    setStatus("Preparing camera and motion. Tap again when ready.");
    return;
  }
  activePointer = event.pointerId;
  pressStartedAt = performance.now();
  pressStamped = false;
  setShutterState("PRESSING");
  const rect = document.getElementById("lock-indicator").getBoundingClientRect();
  lockCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  event.currentTarget.setPointerCapture(event.pointerId);
  // Immediate first fragment. Further frames wait only for tap disambiguation.
  pressStamped = stampCurrentFragment();
}

function shutterMove(event) {
  if (infoOpen || event.pointerId !== activePointer || shutterState !== "PRESSING") return;
  event.preventDefault();
  // Enter the visible lock target, not merely any point outside the shutter.
  if (Math.abs(event.clientX - lockCenter.x) <= 32 &&
      Math.abs(event.clientY - lockCenter.y) <= 28) {
    setShutterState("LOCKED");
    setStatus("Drawing locked. Tap STOP to finish.");
  }
}

function finishPointer(event) {
  if (event.pointerId !== activePointer) return;
  event.preventDefault();
  activePointer = null;
  if (shutterState !== "LOCKED") pauseDrawing();
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
}
function shutterUp(event) { finishPointer(event); }
function shutterCancel(event) { finishPointer(event); }

function ensureTracking() {
  if (orientationListening) {
    if (!video) startCamera();
    return Promise.resolve();
  }
  if (trackingRequest) return trackingRequest;
  trackingRequest = initializeTracking().finally(() => { trackingRequest = null; });
  return trackingRequest;
}

async function initializeTracking() {
  recalibrateMotion();
  try {
    if (!window.isSecureContext) throw new Error("Open the secure HTTPS preview to use camera and motion.");
    if (!window.DeviceOrientationEvent) throw new Error("This browser does not provide phone orientation data.");
    const orientationPermission = typeof window.DeviceOrientationEvent.requestPermission === "function"
      ? window.DeviceOrientationEvent.requestPermission() : Promise.resolve("granted");
    const motionPermission = requestSizingPermission();
    const [permission, sizingPermission] = await Promise.all([orientationPermission, motionPermission]);
    if (permission !== "granted") throw new Error("Motion access denied. Allow motion in website settings, then tap the shutter.");
    window.addEventListener("deviceorientation", handleOrientation);
    orientationListening = true;
    if (sizingPermission === "granted") {
      window.addEventListener("devicemotion", handleDeviceMotion);
      motionSource = "waiting for accelerometer";
    }
    setStatus("Hold your starting pose while the camera and motion become ready.");
    if (!video) startCamera();
    clearTimeout(sensorTimer);
    sensorTimer = setTimeout(() => {
      if (!neutralOrientation) setStatus("No orientation data received. Check motion permissions.");
    }, 5000);
  } catch (error) {
    pauseDrawing();
    setStatus(error.message);
  }
}

function pauseDrawing() {
  activePointer = null;
  setShutterState("IDLE");
  setStatus("Tap to capture · hold to draw");
}

function recalibrateMotion() {
  neutralOrientation = null;
  rawOrientation = null;
  angle = 0;
  targetAngle = 0;
  rawRoll = null;
  neutralRoll = null;
  relativeRoll = 0;
  // Anchor the new neutral pose at the visible, smoothed cursor, not its old target.
  orientationDelta = { x: 0, y: 0 };
  edgeOverflow = { x: 0, y: 0 };
  strokeOrigin = { ...cursor };
  target = { ...cursor };
}

// DeviceOrientation uses Rz(alpha) * Rx(beta) * Ry(gamma).
// Relative rotation avoids Euler wrap jumps and works with an upright phone too.
function orientationMatrix({ alpha, beta, gamma }) {
  const radians = Math.PI / 180;
  const a = (alpha ?? 0) * radians, b = beta * radians, g = gamma * radians;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  return [
    ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg,
    sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg,
    -cb * sg, sb, cb * cg
  ];
}

function relativeTilt(neutral, current, screenAngle) {
  // Current screen normal expressed in the neutral phone's coordinate frame.
  const x = neutral[0] * current[2] + neutral[3] * current[5] + neutral[6] * current[8];
  const y = neutral[1] * current[2] + neutral[4] * current[5] + neutral[7] * current[8];
  const z = neutral[2] * current[2] + neutral[5] * current[5] + neutral[8] * current[8];
  const r = screenAngle * Math.PI / 180;
  const sx = x * Math.cos(r) + y * Math.sin(r);
  const sy = -x * Math.sin(r) + y * Math.cos(r);
  return { x: Math.atan2(sx, z) * 180 / Math.PI,
    y: -Math.atan2(sy, Math.hypot(sx, z)) * 180 / Math.PI };
}

// Project world-up into screen coordinates. Unlike an individual Euler angle,
// this measures the top of the screen leaning sideways, independent of heading.
function screenRoll(matrix, screenAngle) {
  const r = screenAngle * Math.PI / 180;
  const upRight = matrix[6] * Math.cos(r) + matrix[7] * Math.sin(r);
  const upTop = -matrix[6] * Math.sin(r) + matrix[7] * Math.cos(r);
  // When the screen is nearly horizontal, upright roll is undefined. Hold the
  // last valid angle rather than amplifying noise or calibrating an arbitrary zero.
  if (Math.hypot(upRight, upTop) < 0.15) return null;
  return -Math.atan2(upRight, upTop) * 180 / Math.PI;
}

function updatePhoneRoll(matrix, screenAngle) {
  rawRoll = screenRoll(matrix, screenAngle);
  if (rawRoll === null) return;
  if (neutralRoll === null) neutralRoll = rawRoll;
  relativeRoll = ((rawRoll - neutralRoll + 540) % 360) - 180;
  targetAngle = Math.max(-rollSettings.maxDegrees,
    Math.min(rollSettings.maxDegrees, relativeRoll)) * Math.PI / 180;
}

function handleOrientation(event) {
  if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;
  rawOrientation = { alpha: event.alpha, beta: event.beta, gamma: event.gamma };
  lastSensorAt = performance.now();
  const current = orientationMatrix(rawOrientation);
  if (!neutralOrientation) {
    neutralOrientation = current;
    clearTimeout(sensorTimer);
  }
  const screenAngle = window.screen?.orientation?.angle ?? window.orientation ?? 0;
  const tilt = relativeTilt(neutralOrientation, current, screenAngle);
  orientationDelta = tilt;
  const mappedX = strokeOrigin.x - tilt.x / motionSettings.range * width / 2;
  const mappedY = strokeOrigin.y - tilt.y / motionSettings.range * height / 2;
  target.x = Math.max(0, Math.min(width, mappedX));
  target.y = Math.max(0, Math.min(height, mappedY));
  edgeOverflow = { x: mappedX - target.x, y: mappedY - target.y };
  // Discard outward overshoot in the mapping itself, not just its displayed
  // result. A small reversal then moves inward immediately, without having to
  // undo off-screen travel. Neutral orientation and stamp rotation stay intact.
  strokeOrigin.x -= edgeOverflow.x;
  strokeOrigin.y -= edgeOverflow.y;
  updatePhoneRoll(current, screenAngle);
  if (isDrawing && !cameraStarting && shutterState !== "LOCKED") setStatus("");
}

function updateMotionCursor() {
  const blend = 1 - Math.exp(-Math.min(deltaTime, 50) / motionSettings.smoothingMs);
  cursor.x += (target.x - cursor.x) * blend;
  cursor.y += (target.y - cursor.y) * blend;
  const rollBlend = 1 - Math.exp(-Math.min(deltaTime, 50) / rollSettings.smoothingMs);
  angle += (targetAngle - angle) * rollBlend;
}

async function requestSizingPermission() {
  try {
    if (!window.DeviceMotionEvent) return "unavailable";
    if (typeof window.DeviceMotionEvent.requestPermission !== "function") return "granted";
    const permission = await window.DeviceMotionEvent.requestPermission();
    if (permission !== "granted") motionSource = "motion denied — default size";
    return permission;
  } catch {
    motionSource = "motion unavailable — default size";
    return "unavailable";
  }
}

function validAcceleration(value) {
  return value && [value.x, value.y, value.z].every(Number.isFinite);
}

function handleDeviceMotion(event) {
  const now = performance.now();
  const gap = lastMotionAt === null || now - lastMotionAt > 1500;
  const dt = gap ? 16 : Math.max(1, Math.min(100, now - lastMotionAt));
  let intensity;
  if (validAcceleration(event.acceleration)) {
    const a = event.acceleration;
    intensity = Math.hypot(a.x, a.y, a.z);
    motionSource = "linear acceleration";
  } else if (validAcceleration(event.accelerationIncludingGravity)) {
    const a = event.accelerationIncludingGravity;
    const magnitude = Math.hypot(a.x, a.y, a.z);
    // Magnitude is invariant to phone tilt. Remove a slowly changing gravity
    // baseline rather than treating a change of holding angle as walking.
    if (gap || gravityMagnitude === null) gravityMagnitude = magnitude;
    gravityMagnitude += (magnitude - gravityMagnitude) * (1 - Math.exp(-dt / 4000));
    intensity = Math.abs(magnitude - gravityMagnitude);
    motionSource = "gravity-filtered fallback";
  } else return;
  if (!Number.isFinite(intensity)) return;
  lastMotionAt = now;
  rawMotionIntensity = intensity;
  if (gap) {
    motionEnvelope = sizingSettings.normal;
    smoothedMotionIntensity = sizingSettings.normal;
  }
  // Clip isolated spikes, average footfalls, then heavily smooth the envelope.
  const limited = Math.min(sizingSettings.spikeLimit, intensity);
  motionEnvelope += (limited - motionEnvelope) * (1 - Math.exp(-dt / sizingSettings.envelopeMs));
  smoothedMotionIntensity += (motionEnvelope - smoothedMotionIntensity) *
    (1 - Math.exp(-dt / sizingSettings.smoothingMs));
}

function intensityToScale(intensity) {
  const { slow, normal, fast, minScale, maxScale } = sizingSettings;
  const value = Math.max(slow, Math.min(fast, intensity));
  if (value <= normal) return maxScale + (1 - maxScale) * (value - slow) / (normal - slow);
  return 1 + (minScale - 1) * (value - normal) / (fast - normal);
}

function updateFragmentSize() {
  const fresh = lastMotionAt !== null && performance.now() - lastMotionAt < 1500;
  const desired = fresh ? intensityToScale(smoothedMotionIntensity) : 1;
  sizeScale += (desired - sizeScale) *
    (1 - Math.exp(-Math.min(deltaTime, 50) / sizingSettings.sizeSmoothingMs));
}

function fragmentSize() {
  const defaultSize = Math.min(motionSettings.stampSize, Math.min(width, height) * 0.4);
  return defaultSize * sizeScale;
}

function updateDebug() {
  if (!debugEnabled || !debugPanel) return;
  const number = value => Number.isFinite(value) ? value.toFixed(1) : "—";
  debugPanel.textContent = `RAW ORIENTATION\nα ${number(rawOrientation?.alpha)}  β ${number(rawOrientation?.beta)}  γ ${number(rawOrientation?.gamma)}\nHEADING α ${number(rawOrientation?.alpha)}° / VERTICAL β ${number(rawOrientation?.beta)}°\nROLL RAW ${number(rawRoll)}° / NEUTRAL ${number(neutralRoll)}°\nROLL RELATIVE ${number(relativeRoll)}°\nRELATIVE TILT ${number(orientationDelta.x)} / ${number(orientationDelta.y)}°\nTARGET ${number(target.x)} / ${number(target.y)}\nDISCARDED OVERFLOW ${number(edgeOverflow.x)} / ${number(edgeOverflow.y)} px\nSMOOTHED / FINAL CURSOR\nx ${number(cursor.x)}  y ${number(cursor.y)}\nROTATION ${number(angle * 180 / Math.PI)}°\nCAMERA ${video?.elt.videoWidth || 0} × ${video?.elt.videoHeight || 0}\nMOTION RAW ${number(rawMotionIntensity)} m/s²\nMOTION SMOOTH ${number(smoothedMotionIntensity)} m/s²\nFRAGMENT ${number(fragmentSize())} × ${number(fragmentSize() * 0.75)} px\n${lastMotionAt !== null && performance.now() - lastMotionAt >= 1500 ? "motion stale — default size" : motionSource}\nHide: set DEBUG_MODE = false\n${shutterState}`;
  debugCursor.style.left = `${cursor.x}px`;
  debugCursor.style.top = `${cursor.y}px`;
}

function updateDrawControl() {
  const button = document.getElementById("shutter");
  button.dataset.state = shutterState;
  button.setAttribute("aria-label", shutterState === "LOCKED" ? "Stop drawing" : "Capture fragment; hold to draw, slide up to lock");
  button.setAttribute("aria-pressed", String(isDrawing));
  const indicator = document.getElementById("lock-indicator");
  indicator.dataset.state = shutterState;
  document.getElementById("lock-icon").textContent = shutterState === "LOCKED" ? "lock" : "lock_open";
  document.getElementById("shutter-label").textContent = shutterState === "LOCKED" ? "STOP" : "";
}

function startCamera() {
  if (!navigator.mediaDevices || !window.isSecureContext) {
    pauseDrawing();
    setStatus("Open Footage over HTTPS or localhost to use the camera.");
    return;
  }
  cameraStarting = true;
  setStatus("Allow camera access to start drawing.");
  video = createCapture({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    }
  }, () => {
    clearTimeout(cameraTimer);
    cameraStarting = false;
    setStatus("Tap to capture · hold to draw");
  });
  video.elt.setAttribute("playsinline", "");
  video.elt.muted = true;
  video.hide();
  // p5 handles capture failures internally; provide a visible recovery hint.
  cameraTimer = setTimeout(() => {
    if (cameraStarting) {
      setStatus("Camera unavailable or awaiting permission. Allow camera access, then reload to retry.");
    }
  }, 15000);
}

function resetCanvas() {
  background(0);
  // Clearing preserves DRAW / PAUSE state.
}

function draw() {
  if (neutralOrientation) updateMotionCursor();
  updateFragmentSize();
  updateDebug();
  if (!isDrawing) return;
  if (shutterState === "PRESSING" && pressStamped &&
      performance.now() - pressStartedAt < TAP_WINDOW_MS) return;
  if (stampCurrentFragment()) pressStamped = true;
}

function canStamp() {
  return Boolean(!infoOpen && neutralOrientation && performance.now() - lastSensorAt <= 1000 &&
    video && video.elt.readyState >= 2 && video.elt.videoWidth);
}

function stampCurrentFragment() {
  if (!canStamp()) return false;
  stampVideo(cursor.x, cursor.y, fragmentSize());
  if (!hasCaptured) {
    hasCaptured = true;
    document.getElementById("intro").classList.add("dismissed");
  }
  return true;
}

function stampVideo(x, y, baseSize) {
  drawStampAt(x, y, baseSize);
}

function drawStampAt(x, y, baseSize) {
  let currentW = baseSize;
  let currentH = baseSize * 0.75;
  push();
  translate(x, y);
  rotate(angle);
  // Crop to the original 4:3 rectangle without distorting portrait camera input.
  // Rear-facing footage is intentionally unmirrored.
  const sourceW = video.elt.videoWidth;
  const sourceH = video.elt.videoHeight;
  const cropW = Math.min(sourceW, sourceH * currentW / currentH);
  const cropH = cropW * currentH / currentW;
  // Read the native camera frame directly, avoiding p5's intermediate media canvas.
  drawingContext.imageSmoothingEnabled = true;
  drawingContext.imageSmoothingQuality = "high";
  drawingContext.drawImage(video.elt,
    (sourceW - cropW) / 2, (sourceH - cropH) / 2, cropW, cropH,
    -currentW / 2, -currentH / 2, currentW, currentH);
  pop();
}

function windowResized() {
  if (!canvas) return;
  const host = document.getElementById("canvas-host");
  const nextW = host.clientWidth;
  const nextH = host.clientHeight;
  if (!nextW || !nextH || (nextW === width && nextH === height)) return;
  const previous = get();
  const fit = Math.min(nextW / width, nextH / height);
  cursor.x *= nextW / width;
  cursor.y *= nextH / height;
  target.x *= nextW / width;
  target.y *= nextH / height;
  strokeOrigin.x *= nextW / width;
  strokeOrigin.y *= nextH / height;
  resizeCanvas(nextW, nextH, true);
  background(0);
  // Fit the complete existing artwork into the new viewport without cropping.
  image(previous, width / 2, height / 2, previous.width * fit, previous.height * fit);
}
