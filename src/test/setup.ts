import "@testing-library/jest-dom/vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.ResizeObserver = ResizeObserverMock;

global.requestAnimationFrame = (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(Date.now()), 16);
global.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

// jsdom has no real 2D context. Return a permissive stub so the canvas
// centerpiece (glass sphere, particles, constellation) can run its draw
// loop in tests without throwing: every method is a no-op, gradients
// expose addColorStop, and measureText returns a width.
const gradientStub = { addColorStop: () => undefined };
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => {
    const explicit: Record<string, unknown> = {
      measureText: (text: string) => ({ width: text.length * 7 }),
      createRadialGradient: () => gradientStub,
      createLinearGradient: () => gradientStub,
    };
    return new Proxy(explicit, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // unknown method → no-op; property reads are harmless undefineds
        return () => undefined;
      },
      set() {
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  },
});
