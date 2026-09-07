import type { Fixture } from "../demo-lib";
import { aider } from "./aider";
import { amazonQ } from "./amazon-q";
import { antigravity } from "./antigravity";
import { cline } from "./cline";
import { continueDev } from "./continue";
import { crush } from "./crush";
import { forgecode } from "./forgecode";
import { gemini } from "./gemini";
import { goose } from "./goose";
import { kiro } from "./kiro";
import { llm } from "./llm";
import { ompi } from "./ompi";
import { openhands } from "./openhands";
import { openinterpreter } from "./openinterpreter";
import { pearai } from "./pearai";
import { qwen } from "./qwen";
import { vibe } from "./vibe";
import { zed } from "./zed";

/** Every fixture module is registered here; order only affects the session slot numbering. */
export const FIXTURES: Fixture[] = [
  gemini,
  qwen,
  antigravity,
  openinterpreter,
  ompi,
  amazonQ,
  kiro,
  goose,
  llm,
  forgecode,
  crush,
  cline,
  continueDev,
  pearai,
  zed,
  aider,
  openhands,
  vibe,
];
