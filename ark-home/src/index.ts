#!/usr/bin/env bun
// Ark Home — Resource Orchestration Daemon
// The software layer of Element Ark's distributed household resilience network.
// One persistent AI that orchestrates local infrastructure. Personal. Business. Home.

import { Conversation } from './conversation';
import { DEFAULT_CONFIG } from './types';
import { startServer } from './server';
import { ResourceRegistry } from './providers/index';
import { FsProvider } from './providers/fs';
import { DockerProvider } from './providers/docker';
import { NetworkProvider } from './providers/network';
import { PermissionManager } from './permissions';

const config = {
  ...DEFAULT_CONFIG,
  dataDir: process.env.ARK_HOME_DATA || './data',
};

// --- Initialize subsystems ---

const conversation = new Conversation(config);
const permissions = new PermissionManager();

// --- Resource providers ---

const resources = new ResourceRegistry();

// Filesystem provider (read-only by default)
resources.register(new FsProvider({
  roots: [process.env.HOME || '/home'],
  allowWrite: false,
}));

// Docker provider
resources.register(new DockerProvider());

// Network provider with known services
const netProvider = new NetworkProvider({
  services: {
    'llama.cpp': 'http://localhost:8080/health',
    'openjarvis-api': 'http://localhost:9090/health',
    'openjarvis-ui': 'http://localhost:5173',
  },
});
resources.register(netProvider);

// --- Start ---

async function main() {
  console.log('[ark-home] Initializing providers...');
  await resources.initAll();

  const handle = startServer(conversation, config, resources, permissions);
  console.log(`[ark-home] Daemon listening on http://127.0.0.1:${handle.port}`);
  console.log(`[ark-home] API token: ${handle.token.slice(0, 8)}...`);
  console.log('[ark-home] Providers:', resources.list().map(p => p.name).join(', '));

  const stats = conversation.stats();
  if (stats.total > 0) {
    console.log(`[ark-home] ${stats.total} memories loaded`);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[ark-home] Shutting down...');
    handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[ark-home] Fatal:', err);
  process.exit(1);
});
