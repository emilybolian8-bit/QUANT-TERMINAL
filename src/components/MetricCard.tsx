/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ReactNode } from "react";
import { Info } from "lucide-react";

interface MetricCardProps {
  id: string;
  title: string;
  value: string | number;
  subValue?: string;
  badge?: string;
  badgeColor?: string;
  description: string;
  icon?: ReactNode;
  gaugePercent?: number; // 0 to 100
  gaugeType?: "default" | "centered"; // center is for [-1, 1] scales
}

export default function MetricCard({
  id,
  title,
  value,
  subValue,
  badge,
  badgeColor = "bg-[#141417] text-slate-300 border border-[#1f1f23]",
  description,
  icon,
  gaugePercent,
  gaugeType = "default",
}: MetricCardProps) {
  return (
    <div
      id={id}
      className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-5 relative overflow-hidden transition-all hover:border-slate-700/60 flex flex-col justify-between group"
    >
      {/* Top Section */}
      <div className="flex justify-between items-start mb-3">
        <div>
          <span className="text-xs font-mono text-slate-500 uppercase tracking-widest block mb-1">
            {title}
          </span>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-mono font-bold text-white tracking-tight">
              {value}
            </span>
            {badge && (
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${badgeColor}`}>
                {badge}
              </span>
            )}
          </div>
        </div>
        <div className="p-2 bg-[#0a0a0b] border border-[#1f1f23] rounded text-slate-400 group-hover:text-emerald-400 transition-colors">
          {icon || <Info size={16} />}
        </div>
      </div>

      {/* Middle Range Gauge */}
      {gaugePercent !== undefined && (
        <div id={`${id}-gauge`} className="my-3">
          <div className="h-1.5 w-full bg-[#0a0a0b] border border-[#1f1f23]/60 rounded-full relative overflow-hidden">
            {gaugeType === "default" ? (
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                style={{ width: `${gaugePercent}%` }}
              />
            ) : (
              <>
                {/* Center marker line */}
                <div className="absolute left-1/2 top-0 h-full w-[1px] bg-slate-700 z-10" />
                <div
                  className={`absolute h-full transition-all duration-500 rounded-full ${
                    gaugePercent >= 50 ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                  style={{
                    left: gaugePercent >= 50 ? "50%" : `${gaugePercent}%`,
                    width: `${Math.abs(gaugePercent - 50)}%`,
                  }}
                />
              </>
            )}
          </div>
          {gaugeType === "centered" && (
            <div className="flex justify-between text-[9px] font-mono text-slate-500 mt-1">
              <span>-1.0 Inverse</span>
              <span>0.0 Neutral</span>
              <span>1.0 Sync</span>
            </div>
          )}
        </div>
      )}

      {/* Footer Section */}
      <div className="mt-2 pt-2 border-t border-[#1f1f23]">
        {subValue && (
          <span className="text-xs font-mono text-slate-300 block mb-1">
            {subValue}
          </span>
        )}
        <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
          {description}
        </p>
      </div>
    </div>
  );
}
