# Footage

A mobile p5.js canvas that stamps live rear-camera fragments using relative phone orientation.

## Phone testing

Use your working VS Code HTTPS forwarded address. Open it directly in Safari or Chrome on the phone. Tap DRAW and allow camera and motion access when prompted. Hold your starting pose until the permissions finish and the first orientation reading arrives.

The first DRAW starts at the canvas center and records the neutral pose. Tilt left/right or up/down relative to that pose to move the invisible brush. PAUSE stops only camera stamping: the cursor, tilt rotation, and smoothing remain active. DRAW resumes at the current cursor position without recalibrating, leaving a gap where you moved while paused. The debug cursor remains visible during PAUSE. Rotating between portrait and landscape still recalibrates. Returning from a backgrounded page requires DRAW again.

CLEAR / RESTART clears the artwork while retaining the draw/pause state. SAVE IMAGE exports the canvas pixels as PNG, without controls or debugging overlays.

This version uses orientation, not acceleration-based position tracking: moving the phone sideways without changing its angle does not move the brush.

## Development debug

Debugging is hidden by default. Set `const DEBUG_MODE = true;` at the top of `mySketch2.js` and reload to show it. This shows a cursor marker, raw alpha/beta/gamma readings, and smoothed canvas coordinates. Set `DEBUG_MODE` back to `false` and reload to hide the panel and debug cursor. Debugging never paints into the artwork.

The `motionSettings` constant in `mySketch2.js` controls angular range (30 degrees from center to edge), smoothing (90ms), and fragment width (160px maximum, capped at 40% of the shorter viewport dimension). No additional on-screen controls are added.

Run `node --test tests/motion.test.cjs` for synthetic orientation, calibration, smoothing, bounds, and permission-lifecycle checks. Physical sensor feel still requires phone testing.

## Optional alternative preview

`scripts/phone-preview.mjs` is an optional Cloudflare tunnel helper from the earlier server investigation. It requires cloudflared, which was not installed. It is not needed for your VS Code setup. If installed separately, run `CLOUDFLARED_PATH="$(command -v cloudflared)" node scripts/phone-preview.mjs`.

Stamps rotate with sideways phone roll, independently of horizontal aim, with smoothing and no automatic spin. The canvas uses the display pixel density and draws directly from native camera frames; capture requests 1920 × 1080, subject to device support.

## Motion-responsive sizing

Accelerometer intensity controls size continuously: low movement approaches 150% of the default width, typical movement maps to 100%, and high movement approaches 60%. On a 400px-wide viewport these are 240px, 160px, and 96px. The rectangle remains 4:3. Stamping is still frame-driven, never step-triggered; motion sizing also keeps updating during PAUSE.

The app prefers gravity-free acceleration magnitude in m/s². If unavailable, it uses changes in the total acceleration magnitude after removing a slow gravity baseline. This fallback is less sensitive to sideways movement but avoids reading simple phone tilt as walking. This is relative movement intensity, not measured walking velocity; how the phone is held affects readings.

`sizingSettings` contains the development thresholds (slow 0.25, normal 1.5, fast 4 m/s²), size bounds, spike clipping, and filters. A 350ms envelope feeds a 2.5-second smoother, with another 500ms size transition to suppress flicker. These initial thresholds should be tuned with phone walking tests. Missing, denied, or stale motion data uses the default size without disabling the cursor.

The existing debug display includes raw intensity, smoothed intensity, resulting fragment dimensions, and sensor source. Its visibility follows `DEBUG_MODE`.

## Boundary recovery

Targets and smoothed cursor coordinates stay inside the canvas. When the orientation mapping would travel beyond an edge, its position offset absorbs that excess so a small reverse tilt immediately moves the target inward. The neutral orientation, rotation, sensitivity, and 90ms cursor smoothing remain unchanged, and pause/resume never resets this state. After an edge excursion, returning to the original phone pose may therefore land at a different canvas position; this intentionally avoids having to undo invisible off-screen travel.

Debug mode shows relative tilt, constrained target, discarded edge overflow, and the smoothed/final cursor alongside sizing readings. Motion intensity only updates sizing variables. Regression tests exercise all four boundaries through pause/resume and verify that accelerometer updates cannot alter cursor state.


## Independent roll rotation

Cursor aiming retains the existing relative screen-normal mapping and edge handling. Rectangle rotation instead measures world-up projected into the phone screen plane, adjusted for screen orientation. Alpha is the raw heading-related Euler value, beta the raw vertical-related value; neither gamma nor any other single Euler field is assumed to be upright-phone roll. This uses the existing DeviceOrientation rotation matrix; DeviceMotion acceleration remains exclusive to sizing.

The first valid roll reading establishes neutral. Relative roll uses the shortest angular difference, is limited to ±45°, and has its own 90ms smoothing. Left lean rotates counterclockwise; right lean rotates clockwise. Pause continues tracking and smoothing roll, and resume retains neutral and current rotation. The existing screen-orientation change calibration also resets roll. Near a horizontal/flat phone pose, upright roll is undefined, so the last valid rotation is held until it can be measured again.

Debug shows raw alpha/beta/gamma, heading/vertical values, derived raw roll, neutral roll, relative roll, smoothed rotation, and cursor state. Tests cover aim/roll separation, both roll signs, screen orientation, neutral offset, angle wrap, bounds, paused roll tracking, and resume without recalibration. Validate the physical feel on the target phone.
