import type { Metadata } from "next";
import { TrainHub } from "./train-hub";

export const metadata: Metadata = { title: "Train — GAMBIT" };

export default function TrainPage() {
  return <TrainHub />;
}
