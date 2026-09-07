import path from "node:path";
import type { Fixture } from "../demo-lib";
import { writeContinueSessions } from "./continue";

/** PearAI: the Continue session format under `~/.pearai/sessions`. */
export const pearai: Fixture = (d) => {
  const globalDir = path.join(d.HOME, ".pearai");
  writeContinueSessions(d, globalDir, "PearAI", 2);
  d.write(path.join(globalDir, "config.json"), JSON.stringify({ models: [{ title: "PearAI Model", provider: "pearai_server", model: "pearai_model" }] }));
};
