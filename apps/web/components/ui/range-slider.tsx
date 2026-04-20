"use client";

import { useEffect, useState } from "react";

export function DualRangeSlider({
  min,
  max,
  step,
  value,
  onChange,
  className = "",
}: {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  className?: string;
}) {
  const [minVal, setMinVal] = useState(value[0]);
  const [maxVal, setMaxVal] = useState(value[1]);

  useEffect(() => {
    setMinVal(value[0]);
    setMaxVal(value[1]);
  }, [value[0], value[1]]);

  // Ensure minimums don't visually break
  const safeMinVal = Math.min(minVal, maxVal);
  const safeMaxVal = Math.max(minVal, maxVal);

  const minPercent = ((safeMinVal - min) / (max - min)) * 100;
  const maxPercent = ((safeMaxVal - min) / (max - min)) * 100;

  return (
    <div className={`relative flex h-5 w-full items-center ${className}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeMinVal}
        onChange={(e) => {
          const val = Math.min(Number(e.target.value), safeMaxVal);
          setMinVal(val);
          onChange([val, safeMaxVal]);
        }}
        className="pointer-events-none absolute z-20 h-0 w-full appearance-none outline-none slider-thumb-min"
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeMaxVal}
        onChange={(e) => {
          const val = Math.max(Number(e.target.value), safeMinVal);
          setMaxVal(val);
          onChange([safeMinVal, val]);
        }}
        className="pointer-events-none absolute z-30 h-0 w-full appearance-none outline-none slider-thumb-max"
      />
      <div className="relative z-10 w-full h-[5px] rounded-full bg-[rgba(21,111,99,0.12)]">
        <div
          className="absolute h-full rounded-full bg-[var(--accent)]"
          style={{ left: `${minPercent}%`, width: `${maxPercent - minPercent}%` }}
        />
      </div>
      <style jsx global>{`
        .slider-thumb-min::-webkit-slider-thumb,
        .slider-thumb-max::-webkit-slider-thumb {
          appearance: none;
          pointer-events: auto;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(21,111,99,0.3);
          transition: transform 0.15s ease;
        }
        .slider-thumb-min::-webkit-slider-thumb:hover,
        .slider-thumb-max::-webkit-slider-thumb:hover {
          transform: scale(1.15);
        }
        .slider-thumb-min::-moz-range-thumb,
        .slider-thumb-max::-moz-range-thumb {
          pointer-events: auto;
          width: 20px;
          height: 20px;
          border: none;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(21,111,99,0.3);
          transition: transform 0.15s ease;
        }
        .slider-thumb-min::-moz-range-thumb:hover,
        .slider-thumb-max::-moz-range-thumb:hover {
          transform: scale(1.15);
        }
      `}</style>
    </div>
  );
}
