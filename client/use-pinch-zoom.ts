import { useCallback, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type NativeTouchEvent,
  Platform,
  type ScrollView,
  type View,
} from "react-native";
import {
  clampOffset,
  clampZoom,
  flingOffset,
  focalOffset,
  keepsResponder,
  panOffset,
  pinchScale,
  type ResponderClaim,
  responderClaim,
  scaleShift,
  tapZoom,
  wheelScale,
} from "./paging";
import { onPinchWheel, type PinchWheel } from "./web";

const PENDING_SCROLL_MS = 500;
const TAP_MS = 250;
const TAP_SLOP_DP = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_DP = 30;
const FLING_IDLE_MS = 80;
// A wheel pinch has no end event; it ends once its wheel events stop.
const WHEEL_PINCH_IDLE_MS = 150;

type Point = { x: number; y: number };
type Live = { scale: number; shift: Point };
type Pinch = { distance: number; anchor: Point; focal: Point; scale: number };
type Touch = { at: number; point: Point };
type Drag = { start: Point; offset: Point; last: Touch; velocity: Point };

const midpoint = (a: NativeTouchEvent, b: NativeTouchEvent): Point => ({ x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 });
const distance = (a: NativeTouchEvent, b: NativeTouchEvent) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
const near = (a: Point, b: Point, slop: number) => Math.abs(a.x - b.x) <= slop && Math.abs(a.y - b.y) <= slop;
const touchPoint = (touch: NativeTouchEvent): Point => ({ x: touch.pageX, y: touch.pageY });

function scrollSoon(scroll: () => void) {
  scroll();
  requestAnimationFrame(scroll);
}

export function usePinchZoom(zoom: number, setZoom: (zoom: number) => void, enabled: boolean, gutter: number) {
  const [live, setLive] = useState<Live | null>(null);
  const frame = useRef<View>(null);
  const outer = useRef<ScrollView>(null);
  const pan = useRef<ScrollView>(null);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const viewport = useRef({ width: 0, height: 0 });
  const body = useRef({ width: 0, height: 0 });
  const scroll = useRef<Point>({ x: 0, y: 0 });
  const pending = useRef<Partial<Point>>({});
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinch = useRef<Pinch | null>(null);
  const drag = useRef<Drag | null>(null);
  const claim = useRef<ResponderClaim | null>(null);
  const outerContent = useRef(0);
  const touchStart = useRef<Touch | null>(null);
  const lastTap = useRef<Touch | null>(null);
  const multiTouch = useRef(false);
  const pinchable = enabled && Platform.OS !== "web";
  const wheelEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchWheel = useRef<(wheel: PinchWheel) => boolean>(() => false);
  const stopPinchWheel = useRef(() => {});

  const measureOrigin = () =>
    frame.current?.measure((_x, _y, _width, _height, pageX, pageY) => {
      origin.current = { x: pageX, y: pageY };
    });

  const anchorAt = (page: Point): Point => ({ x: page.x - origin.current.x - gutter, y: page.y - origin.current.y - gutter });

  const commit = (target: number, anchor: Point | null) => {
    const next = clampZoom(target);
    setLive(null);
    if (next === zoom) return;
    const ratio = next / zoom;
    pending.current = anchor
      ? { x: focalOffset(scroll.current.x, anchor.x, ratio), y: focalOffset(scroll.current.y, anchor.y, ratio) }
      : { x: 0 };
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      pending.current = {};
    }, PENDING_SCROLL_MS);
    setZoom(next);
  };

  const claimFor = (event: GestureResponderEvent) => responderClaim({ touches: event.nativeEvent.touches.length, zoom, pinchable });

  const beginPinch = (anchor: Point, startDistance: number): Pinch => {
    claim.current = "pinch";
    drag.current = null;
    pinch.current = {
      distance: startDistance,
      anchor,
      focal: { x: scroll.current.x + anchor.x, y: scroll.current.y + anchor.y },
      scale: 1,
    };
    return pinch.current;
  };

  const startPinch = (a: NativeTouchEvent, b: NativeTouchEvent) => beginPinch(anchorAt(midpoint(a, b)), distance(a, b));

  const showPinch = (current: Pinch, scale: number) => {
    current.scale = scale;
    setLive({
      scale,
      shift: {
        x: scaleShift(current.focal.x, body.current.width / 2, scale),
        y: scaleShift(current.focal.y, body.current.height / 2, scale),
      },
    });
  };

  const movePinch = (a: NativeTouchEvent, b: NativeTouchEvent) => {
    const current = pinch.current;
    if (current) showPinch(current, pinchScale(current.distance, distance(a, b), zoom));
  };

  // Web only: the wheel events of a trackpad pinch scale the page around the pointer, like two fingers.
  pinchWheel.current = (wheel) => {
    if (!enabled) return false;
    const current = pinch.current ?? beginPinch({ x: wheel.x - gutter, y: wheel.y - gutter }, 0);
    showPinch(current, wheelScale(current.scale, wheel.deltaY, zoom));
    if (wheelEnd.current) clearTimeout(wheelEnd.current);
    wheelEnd.current = setTimeout(() => {
      wheelEnd.current = null;
      endGesture(false);
    }, WHEEL_PINCH_IDLE_MS);
    return true;
  };

  const setFrame = useCallback((node: View | null) => {
    frame.current = node;
    stopPinchWheel.current();
    stopPinchWheel.current = onPinchWheel(node, (wheel) => pinchWheel.current(wheel));
  }, []);

  const startPan = (touch: NativeTouchEvent) => {
    const point = touchPoint(touch);
    claim.current = "pan";
    drag.current = { start: point, offset: { ...scroll.current }, last: { at: Date.now(), point }, velocity: { x: 0, y: 0 } };
  };

  const scrollBoth = (x: number, y: number, animated: boolean) => {
    pan.current?.scrollTo({ x, animated });
    outer.current?.scrollTo({ y, animated });
  };

  const movePan = (touch: NativeTouchEvent) => {
    const current = drag.current;
    if (!current) return;
    const point = touchPoint(touch);
    const at = Date.now();
    const elapsed = at - current.last.at;
    if (elapsed > 0) {
      current.velocity = { x: (point.x - current.last.point.x) / elapsed, y: (point.y - current.last.point.y) / elapsed };
    }
    current.last = { at, point };
    scrollBoth(
      panOffset(current.offset.x, point.x - current.start.x, body.current.width, viewport.current.width),
      panOffset(current.offset.y, point.y - current.start.y, outerContent.current, viewport.current.height),
      false,
    );
  };

  const endGesture = (fling: boolean) => {
    const current = pinch.current;
    const dragged = drag.current;
    pinch.current = null;
    drag.current = null;
    claim.current = null;
    if (current) commit(zoom * current.scale, current.anchor);
    if (!fling || !dragged || Date.now() - dragged.last.at > FLING_IDLE_MS) return;
    scrollBoth(
      flingOffset(scroll.current.x, dragged.velocity.x, body.current.width, viewport.current.width),
      flingOffset(scroll.current.y, dragged.velocity.y, outerContent.current, viewport.current.height),
      true,
    );
  };

  const frameProps = {
    ref: setFrame,
    style: { flex: 1 },
    onLayout: (event: LayoutChangeEvent) => {
      viewport.current.height = event.nativeEvent.layout.height;
      measureOrigin();
    },
    onTouchStart: (event: GestureResponderEvent) => {
      measureOrigin();
      const { touches, pageX, pageY } = event.nativeEvent;
      if (touches.length > 1) multiTouch.current = true;
      else if (!multiTouch.current) touchStart.current = { at: Date.now(), point: { x: pageX, y: pageY } };
    },
    onTouchEnd: (event: GestureResponderEvent) => {
      if (event.nativeEvent.touches.length > 0) return;
      const start = touchStart.current;
      const wasMulti = multiTouch.current;
      touchStart.current = null;
      multiTouch.current = false;
      if (!pinchable || wasMulti || !start) return;
      const tap = { at: Date.now(), point: { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY } };
      if (tap.at - start.at > TAP_MS || !near(tap.point, start.point, TAP_SLOP_DP)) {
        lastTap.current = null;
        return;
      }
      const previous = lastTap.current;
      if (previous && tap.at - previous.at <= DOUBLE_TAP_MS && near(tap.point, previous.point, DOUBLE_TAP_SLOP_DP)) {
        lastTap.current = null;
        commit(tapZoom(zoom), anchorAt(tap.point));
      } else {
        lastTap.current = tap;
      }
    },
    onStartShouldSetResponderCapture: (event: GestureResponderEvent) => claimFor(event) !== null,
    onMoveShouldSetResponderCapture: (event: GestureResponderEvent) => claimFor(event) !== null,
    onResponderGrant: (event: GestureResponderEvent) => {
      const [a, b] = event.nativeEvent.touches;
      if (a && b) startPinch(a, b);
      else if (a && claimFor(event) === "pan") startPan(a);
      return true;
    },
    onResponderMove: (event: GestureResponderEvent) => {
      const [a, b] = event.nativeEvent.touches;
      if (a && b && pinchable) {
        if (claim.current === "pinch") movePinch(a, b);
        else startPinch(a, b);
      } else if (a && claim.current === "pan") {
        movePan(a);
      }
    },
    onResponderRelease: () => endGesture(true),
    onResponderTerminate: () => endGesture(false),
    onResponderTerminationRequest: () => !keepsResponder(claim.current),
  };

  const outerProps = {
    ref: outer,
    scrollEnabled: live === null,
    scrollEventThrottle: 16,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scroll.current.y = event.nativeEvent.contentOffset.y;
    },
    onContentSizeChange: (_width: number, height: number) => {
      outerContent.current = height;
      const y = pending.current.y;
      if (y === undefined) return;
      pending.current.y = undefined;
      scrollSoon(() => outer.current?.scrollTo({ y: clampOffset(y, height, viewport.current.height), animated: false }));
    },
  };

  const panProps = {
    ref: pan,
    scrollEnabled: zoom > 1 && live === null,
    scrollEventThrottle: 16,
    onLayout: (event: LayoutChangeEvent) => {
      viewport.current.width = event.nativeEvent.layout.width;
    },
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scroll.current.x = event.nativeEvent.contentOffset.x;
    },
    onContentSizeChange: (width: number) => {
      const x = pending.current.x;
      if (x === undefined) return;
      pending.current.x = undefined;
      scrollSoon(() => pan.current?.scrollTo({ x: clampOffset(x, width, viewport.current.width), animated: false }));
    },
  };

  const bodyProps = {
    onLayout: (event: LayoutChangeEvent) => {
      body.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
    },
    style: live
      ? { transform: [{ translateX: live.shift.x }, { translateY: live.shift.y }, { scale: live.scale }] }
      : undefined,
  };

  return { zoomTo: (next: number) => commit(next, null), frameProps, outerProps, panProps, bodyProps };
}
