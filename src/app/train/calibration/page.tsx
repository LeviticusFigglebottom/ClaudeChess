import type { Metadata } from "next";
import { CalibrationClient } from "./calibration-client";

export const metadata: Metadata = { title: "Eval calibration — GAMBIT" };

export default function CalibrationPage() {
  return <CalibrationClient />;
}
