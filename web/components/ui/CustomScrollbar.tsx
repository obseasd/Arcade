"use client";

import { useEffect, useRef } from "react";

/**
 * Floating overlay scrollbar — a fake thumb rendered over the page. The native
 * scrollbar is hidden in globals.css; this paints only a blue thumb (no track,
 * no background band), positioned/sized proportionally to the document scroll.
 * Mounted once in the root layout.
 */
export function CustomScrollbar() {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;

    const doc = document.documentElement;
    let scrollTimer: ReturnType<typeof setTimeout>;
    let dragStartY = 0;
    let dragStartScroll = 0;

    const getMetrics = () => {
      const scrollHeight = doc.scrollHeight;
      const clientHeight = doc.clientHeight;
      const thumbHeight = Math.max((clientHeight / scrollHeight) * clientHeight, 50);
      const maxThumbTop = clientHeight - thumbHeight;
      const maxScroll = scrollHeight - clientHeight;
      return { thumbHeight, maxThumbTop, maxScroll };
    };

    const updateThumb = () => {
      const { thumbHeight, maxThumbTop, maxScroll } = getMetrics();
      if (maxScroll <= 0) {
        thumb.style.display = "none";
        return;
      }
      thumb.style.display = "block";
      const ratio = window.scrollY / maxScroll;
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.top = `${ratio * maxThumbTop}px`;
    };

    const onScroll = () => {
      updateThumb();
      track.classList.add("scrolling");
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => track.classList.remove("scrolling"), 1200);
    };

    const onDragMove = (e: MouseEvent) => {
      const { maxThumbTop, maxScroll } = getMetrics();
      if (maxThumbTop <= 0) return;
      const dy = e.clientY - dragStartY;
      window.scrollTo(0, dragStartScroll + (dy / maxThumbTop) * maxScroll);
    };
    const onDragUp = () => {
      track.classList.remove("dragging");
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragUp);
    };
    const onThumbDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragStartY = e.clientY;
      dragStartScroll = window.scrollY;
      track.classList.add("dragging");
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onDragMove);
      window.addEventListener("mouseup", onDragUp);
    };

    // Click on the empty track jumps (smoothly) to that position.
    const onTrackClick = (e: MouseEvent) => {
      if (e.target === thumb) return;
      const { thumbHeight, maxThumbTop, maxScroll } = getMetrics();
      if (maxThumbTop <= 0) return;
      const targetTop = e.clientY - thumbHeight / 2;
      const ratio = Math.max(0, Math.min(1, targetTop / maxThumbTop));
      window.scrollTo({ top: ratio * maxScroll, behavior: "smooth" });
    };

    thumb.addEventListener("mousedown", onThumbDown);
    track.addEventListener("mousedown", onTrackClick);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateThumb, { passive: true });
    // Re-measure when the page height changes (route changes, lazy content…).
    const ro = new ResizeObserver(updateThumb);
    ro.observe(document.body);

    updateThumb();

    return () => {
      thumb.removeEventListener("mousedown", onThumbDown);
      track.removeEventListener("mousedown", onTrackClick);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateThumb);
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragUp);
      ro.disconnect();
      clearTimeout(scrollTimer);
    };
  }, []);

  return (
    <div ref={trackRef} className="arc-scrollbar" aria-hidden>
      <div ref={thumbRef} className="arc-scrollbar-thumb" style={{ display: "none" }} />
    </div>
  );
}
