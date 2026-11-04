// Modified by ibmi-agent-kit (2026): Profile carries the password source (plain, helper or OS store) instead of a required password; reportDir names the run report folder.
export type { LoggingLevel as LogLevel } from "@modelcontextprotocol/sdk/types.js";
import type { LoggingLevel as LogLevel } from "@modelcontextprotocol/sdk/types.js";

export interface Reporter {
  step(message: string): void;
  log(level: LogLevel, message: string): void;
}

export const NOOP_REPORTER: Reporter = { step: () => {}, log: () => {} };

export interface Profile {
  host: string;
  user: string;
  // password source: signOnOnce in core fetches it per send, no field here is read directly
  password?: string;
  passwordCommand?: string;
  passwordStore?: "os";
  profileFile?: string;          // the profile file the loader read, for the git work tree check
  port: number;
  tls: boolean;
  tlsInsecure: boolean;
  deviceName?: string;
  terminalType: string;
  ccsid: number;
  rows: number;
  cols: number;
  restricted: boolean;           // allowlist mode: only the guard's list plus allowedCl reach a command line
  allowedCl: string[];           // extra verbs permitted in restricted mode
  blockedCl: string[];           // extra verbs refused when restricted mode is off
  viewerEnabled: boolean;
  viewerPort: number;
  reportDir?: string;            // IBMI_5250_REPORT_DIR: where each session writes its run report; unset = none
  initialLibrary?: string;       // typed into the sign on screen when it offers the field
  initialProgram?: string;
  initialMenu?: string;
}
