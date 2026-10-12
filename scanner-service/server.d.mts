import type { Server } from 'node:http';

export interface ScannerConfig {
  token: string;
  signingSecret: string;
  provider?: string;
  clamdHost?: string;
  clamdPort?: number;
  maxBytes?: number;
  log?: (line: string) => void;
}

export function createScannerServer(config: ScannerConfig): Server;
