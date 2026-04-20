"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl, { type Map } from "maplibre-gl";
import { motion, AnimatePresence } from "framer-motion";
import type { RouteCandidate } from "@adhoc/shared";

type Props = {
  map: Map;
  candidate: RouteCandidate;
  isSelected: boolean;
  isZoomedIn: boolean;
  isZoomedOut: boolean;
  onClick: (id: string) => void;
};

export function StationMarker({ map, candidate, isSelected, isZoomedIn, isZoomedOut, onClick }: Props) {
  const [container] = useState(() => {
    const div = document.createElement("div");
    // Default MapLibre marker styles override pointer-events, let's keep it clean
    div.style.position = "absolute";
    div.style.top = "0";
    div.style.left = "0";
    return div;
  });

  useEffect(() => {
    // Determine sort order roughly based on availability and selected state
    // By keeping it dynamically updated, we don't end up with dead markers on top
    const zIndex = isSelected ? 50 : candidate.availabilitySummary.available > 0 ? 10 : 1;
    container.style.zIndex = zIndex.toString();
  }, [isSelected, candidate.availabilitySummary.available, container]);

  useEffect(() => {
    const marker = new maplibregl.Marker({
      element: container,
      anchor: "center",
    })
      .setLngLat([candidate.lng, candidate.lat])
      .addTo(map);

    return () => {
      marker.remove();
    };
  }, [map, candidate.lng, candidate.lat, container]);

  const totalPoints = candidate.chargePointCount;
  const availablePoints = candidate.availabilitySummary.available;
  const price = candidate.tariffSummary.pricePerKwh;
  const hasAvailability = availablePoints > 0;
  
  // Calculate SVG stroke for the Ring Gauge
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  // ratio of available to total
  const fillRatio = Math.min(Math.max(availablePoints / (totalPoints || 1), 0), 1);
  const strokeDashoffset = circumference - fillRatio * circumference;

  // Theming colors - CI Aligned
  const primaryColor = hasAvailability ? "#156f63" : "#d09a4a"; // Adhoc Green : Adhoc Orange
  const primaryColorSoft = hasAvailability ? "rgba(21, 111, 99, 0.15)" : "rgba(208, 154, 74, 0.15)";
  const trackColor = "#e2e8f0"; // Slate 200 for sharp contrast
  const textColor = hasAvailability ? "text-[#156f63]" : "text-[#b96710]";

  const appleSpring = { type: "spring", stiffness: 350, damping: 30, mass: 1 };

  if (isZoomedOut) {
    return createPortal(
      <div 
        className={`rounded-full shadow-sm transition-transform cursor-pointer ${isSelected ? "h-3 w-3 scale-125 ring-2 ring-white z-50" : "h-2 w-2 hover:scale-150 z-0"}`}
        style={{ 
          backgroundColor: primaryColor,
          boxShadow: `0 0 8px ${primaryColorSoft}` 
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClick(candidate.stationId);
        }}
        aria-label={candidate.stationName}
      />,
      container
    );
  }

  return createPortal(
    <div 
      className={`relative flex items-center justify-center transition-transform hover:scale-110 cursor-pointer ${isSelected ? "scale-125 hover:scale-125 z-50 shadow-2xl" : "z-0"}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(candidate.stationId);
      }}
      aria-label={`${candidate.stationName}: ${availablePoints} von ${totalPoints} frei`}
    >
      {/* 
        THE CORE RING GAUGE
      */}
      <div 
        className="relative flex h-[34px] w-[34px] items-center justify-center rounded-full bg-white shadow-md z-10 overflow-hidden"
        style={{
          boxShadow: isSelected 
            ? `0 0 0 4px white, 0 10px 25px -5px ${primaryColorSoft}` 
            : `0 4px 12px ${primaryColorSoft}`,
        }}
      >
        <svg 
          className="absolute inset-0 h-full w-full -rotate-90 transform" 
          viewBox="0 0 24 24"
        >
          {/* Track */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke={trackColor}
            strokeWidth="3.2"
          />
          {/* Progress */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke={primaryColor}
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-700 ease-out"
          />
        </svg>

        {/* Center Text */}
        <span className={`z-10 font-[var(--font-heading)] font-bold text-[10.5px] tracking-tight ${textColor}`} style={{ marginTop: '1px' }}>
          {candidate.maxPowerKw}
        </span>
      </div>

      {/* 
        UNIFIED SATELLITE BADGE (Zoom Responsive)
      */}
      <AnimatePresence>
        {isZoomedIn && (
          <motion.div
            initial={{ opacity: 0, clipPath: "inset(0% 100% 0% 0%)" }}
            animate={{ opacity: 1, clipPath: "inset(0% 0% 0% 0%)" }}
            exit={{ opacity: 0, clipPath: "inset(0% 100% 0% 0%)", transition: { duration: 0.15 } }}
            transition={appleSpring}
            className="absolute left-[16px] top-1/2 -translate-y-1/2 flex h-[26px] items-center pointer-events-none -z-10"
          >
            {/* Unified Glassmorphism Drawer */}
            <div className="flex h-full items-center rounded-r-full border border-l-0 border-white/60 bg-white/40 pl-[24px] pr-3 shadow-[0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur-xl">
              {/* Availability */}
              <span className={`text-[11.5px] font-bold tracking-tight ${textColor} whitespace-nowrap`}>
                {availablePoints}/{totalPoints}
              </span>

              {/* Separator & Price */}
              {typeof price === "number" && (
                <>
                  <div className="mx-2 h-3.5 w-[1.5px] rounded-full bg-slate-300" />
                  <span className="text-[11.5px] font-semibold tracking-tight text-slate-700 whitespace-nowrap">
                    {(price / 100).toFixed(2).replace('.', ',')}€
                  </span>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    container
  );
}
