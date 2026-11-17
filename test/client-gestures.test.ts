import { describe, expect, it } from "vitest";
import { FLING_SECONDS, flingOffset, keepsResponder, panOffset, imageFitWidth, responderClaim, wheelScale, zoomedText, zoomGroupWidth } from "../client/paging";

describe("zoomed page gestures", () => {
  it("claims a single finger as a pan only when the page is zoomed in", () => {
    expect(responderClaim({ touches: 1, zoom: 2, pinchable: true })).toBe("pan");
    expect(responderClaim({ touches: 1, zoom: 1, pinchable: true })).toBeNull();
  });

  it("claims two fingers as a pinch at any zoom", () => {
    expect(responderClaim({ touches: 2, zoom: 1, pinchable: true })).toBe("pinch");
    expect(responderClaim({ touches: 3, zoom: 2, pinchable: true })).toBe("pinch");
  });

  it("claims nothing where pinch zoom is off (web, text view, no page yet)", () => {
    expect(responderClaim({ touches: 1, zoom: 2, pinchable: false })).toBeNull();
    expect(responderClaim({ touches: 2, zoom: 2, pinchable: false })).toBeNull();
    expect(responderClaim({ touches: 0, zoom: 2, pinchable: true })).toBeNull();
  });

  it("refuses to hand the touch to another responder during a pan or pinch", () => {
    expect(keepsResponder(null)).toBe(false);
    expect(keepsResponder("pan")).toBe(true);
    expect(keepsResponder("pinch")).toBe(true);
  });

  it("moves the content against the finger and stops at the edges", () => {
    expect(panOffset(300, -100, 2000, 400)).toBe(400);
    expect(panOffset(300, 100, 2000, 400)).toBe(200);
    expect(panOffset(50, 100, 2000, 400)).toBe(0);
    expect(panOffset(1500, -200, 2000, 400)).toBe(1600);
  });

  it("carries a released pan on by its velocity, within the content", () => {
    expect(flingOffset(500, -2, 4000, 400)).toBe(500 + 2000 * FLING_SECONDS);
    expect(flingOffset(500, 2, 4000, 400)).toBe(Math.max(0, 500 - 2000 * FLING_SECONDS));
    expect(flingOffset(3500, -5, 4000, 400)).toBe(3600);
    expect(flingOffset(500, 0, 4000, 400)).toBe(500);
  });
});

describe("wheel pinch", () => {
  it("scales by the trackpad's pinch delta, out and back in", () => {
    expect(wheelScale(1, -10, 1)).toBeCloseTo(Math.exp(0.1));
    expect(wheelScale(wheelScale(1, -10, 1), 10, 1)).toBeCloseTo(1);
  });

  it("limits a Ctrl+mouse wheel notch to one bounded step", () => {
    expect(wheelScale(1, -100, 1)).toBeCloseTo(Math.exp(0.5));
    expect(wheelScale(1, -100, 1)).toBe(wheelScale(1, -50, 1));
  });

  it("stays within the zoom range from the current zoom", () => {
    expect(wheelScale(2.9, -50, 1)).toBe(3);
    expect(wheelScale(1, -50, 3)).toBe(1);
    expect(wheelScale(0.6, 50, 2)).toBe(0.5);
  });
});

describe("zoomed slide text", () => {
  it("scales font size, line height and width with the zoom", () => {
    expect(zoomedText({ fontSize: 15, lineHeight: 22 }, 360, 2)).toEqual({ fontSize: 30, lineHeight: 44, maxWidth: 720 });
    expect(zoomedText({ fontSize: 16, lineHeight: 24 }, 300, 1.5)).toEqual({ fontSize: 24, lineHeight: 36, maxWidth: 450 });
  });

  it("leaves text at fit size unchanged", () => {
    expect(zoomedText({ fontSize: 15, lineHeight: 22 }, 360, 1)).toEqual({ fontSize: 15, lineHeight: 22, maxWidth: 360 });
  });
});

describe("image fit", () => {
  const panel = { panelWidth: 366, panelHeight: 600 };

  it("shows a small image at its own size instead of upscaling it", () => {
    expect(imageFitWidth({ ...panel, source: { width: 64, height: 48 } })).toBe(64);
    expect(imageFitWidth({ ...panel, source: { width: 30, height: 100 } })).toBe(30);
  });

  it("shrinks a large image to the panel width, and a tall one to the panel height", () => {
    expect(imageFitWidth({ ...panel, source: { width: 1600, height: 1000 } })).toBe(366);
    expect(imageFitWidth({ ...panel, source: { width: 300, height: 2000 } })).toBe(90);
  });

  it("keeps the source width until the panel height is known", () => {
    expect(imageFitWidth({ panelWidth: 366, panelHeight: 0, source: { width: 64, height: 48 } })).toBe(64);
  });
});

describe("page toolbar", () => {
  it("reserves the zoom controls' width so the copy button does not shift the page counter", () => {
    expect(zoomGroupWidth({ button: 28, label: 44, gap: 8 })).toBe(28 + 8 + 44 + 8 + 28);
  });
});
