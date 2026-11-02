/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from "react";

export default function TerminalBoot({
  onComplete,
}: {
  symbol: string;
  benchmark: string;
  interval: any;
  lookbackDays: number;
  onComplete: () => void;
}) {
  useEffect(() => {
    onComplete();
  }, [onComplete]);
  return null;
}