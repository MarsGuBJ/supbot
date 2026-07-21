import { useCallback, useEffect, useRef } from "react";

export function useStickToBottom(active: boolean, resetKey: string) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageStackRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = scrollRef.current;
    if (!element) return;
    const top = Math.max(0, element.scrollHeight - element.clientHeight);
    if (behavior === "auto") {
      element.scrollTop = top;
      return;
    }
    element.scrollTo({ top, behavior });
  }, []);

  useEffect(() => {
    if (!active) return;
    shouldStickToBottomRef.current = true;
    const pin = () => scrollMessagesToBottom("auto");
    pin();
    const frame = window.requestAnimationFrame(pin);
    const timer = window.setTimeout(pin, 80);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [active, resetKey, scrollMessagesToBottom]);

  useEffect(() => {
    if (!active) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const updateStickiness = () => {
      const distanceFromBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
      shouldStickToBottomRef.current = distanceFromBottom <= 16;
    };
    scrollElement.addEventListener("scroll", updateStickiness, { passive: true });
    return () => scrollElement.removeEventListener("scroll", updateStickiness);
  }, [active, resetKey]);

  useEffect(() => {
    if (!active) return;
    const scrollElement = scrollRef.current;
    const stackElement = messageStackRef.current;
    if (!scrollElement || !stackElement || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const keepPinned = () => {
      if (shouldStickToBottomRef.current) {
        scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      }
    };
    const schedulePin = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(keepPinned);
    };
    const observer = new ResizeObserver(schedulePin);
    observer.observe(stackElement);
    schedulePin();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, resetKey]);

  return { messageStackRef, scrollMessagesToBottom, scrollRef };
}
