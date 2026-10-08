// Best-effort device classification, never based on viewport width.
function supportsMobileExperience(nav, browser) {
  const ua = nav.userAgent || "";
  const touch = (nav.maxTouchPoints || 0) > 0 || "ontouchstart" in browser;
  const motionAPI = typeof browser.DeviceOrientationEvent !== "undefined";
  const cameraAPI = Boolean(nav.mediaDevices?.getUserMedia);
  const phone = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua) || nav.userAgentData?.mobile === true;
  if (phone) return true; // Keep permission/HTTPS diagnostics available on phones.

  // iPadOS can report a desktop Mac user agent, even with a trackpad attached.
  const ipad = /iPad/i.test(ua) || (/Macintosh|MacIntel/i.test(ua + " " + (nav.platform || "")) && (nav.maxTouchPoints || 0) > 1);
  const tablet = ipad || /Android|Tablet|Silk/i.test(ua);
  if (tablet) return touch && motionAPI && cameraAPI;

  // Touchscreen laptops remain desktop. Unknown touch-first devices may try the
  // mobile tool when the required APIs exist; actual sensor data is checked later.
  if (/Windows NT|Macintosh|X11|CrOS/i.test(ua)) return false;
  return touch && browser.matchMedia?.("(pointer: coarse)").matches === true && motionAPI && cameraAPI;
}

window.footageMobile = supportsMobileExperience(navigator, window);
document.documentElement.dataset.experience = window.footageMobile ? "mobile" : "desktop";
