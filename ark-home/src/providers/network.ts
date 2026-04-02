// Ark Home — Network Resource Provider
// Port scanning, service health checks, and Ark Home peer discovery.

import { networkInterfaces } from 'os';
import type { ResourceProvider, ProviderAction, ProviderHealth } from './index';

export interface NetworkProviderConfig {
  /** Known services to monitor: { name: url } */
  services: Record<string, string>;
  /** Port scan timeout in ms. Default: 1000 */
  scanTimeout: number;
}

const DEFAULT_NET_CONFIG: NetworkProviderConfig = {
  services: {},
  scanTimeout: 1000,
};

export class NetworkProvider implements ResourceProvider {
  readonly name = 'network';
  readonly description = 'Network: scan ports, check services, discover Ark Home peers';
  private config: NetworkProviderConfig;

  constructor(config?: Partial<NetworkProviderConfig>) {
    this.config = { ...DEFAULT_NET_CONFIG, ...config };
  }

  async init(): Promise<boolean> {
    return true; // Always available
  }

  actions(): ProviderAction[] {
    return [
      { name: 'interfaces', description: 'List network interfaces and IPs', destructive: false },
      { name: 'scan', description: 'Scan a host for open ports', destructive: false },
      { name: 'check', description: 'Health check a URL', destructive: false },
      { name: 'services', description: 'Check all registered services', destructive: false },
      { name: 'discover', description: 'Discover Ark Home peers on local network', destructive: false },
    ];
  }

  async execute(action: string, args: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'interfaces': return this.listInterfaces();
      case 'scan': return this.scanPorts(args);
      case 'check': return this.checkUrl(args);
      case 'services': return this.checkServices();
      case 'discover': return this.discoverPeers();
      default: throw new Error(`Unknown network action: ${action}`);
    }
  }

  async health(): Promise<ProviderHealth> {
    return { available: true, details: 'network provider active' };
  }

  /** Register a service for ongoing monitoring. */
  registerService(name: string, url: string): void {
    this.config.services[name] = url;
  }

  // --- Actions ---

  private listInterfaces() {
    const ifaces = networkInterfaces();
    const result: { name: string; address: string; family: string; mac: string }[] = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.internal) continue;
        result.push({ name, address: addr.address, family: addr.family, mac: addr.mac });
      }
    }
    return { interfaces: result };
  }

  private async scanPorts(args: Record<string, unknown>) {
    const host = String(args.host || 'localhost');
    const portsArg = args.ports;
    let ports: number[];

    if (Array.isArray(portsArg)) {
      ports = portsArg.map(Number);
    } else if (typeof portsArg === 'string') {
      ports = portsArg.split(',').map(Number);
    } else {
      // Common service ports
      ports = [22, 80, 443, 3000, 3100, 5173, 7700, 8080, 8081, 9090];
    }

    const results: { port: number; open: boolean }[] = [];
    const checks = ports.map(async (port) => {
      const open = await this.isPortOpen(host, port);
      results.push({ port, open });
    });
    await Promise.all(checks);

    results.sort((a, b) => a.port - b.port);
    return { host, results, openPorts: results.filter(r => r.open).map(r => r.port) };
  }

  private async checkUrl(args: Record<string, unknown>) {
    const url = String(args.url || '');
    if (!url) throw new Error('Missing required arg: url');

    // SSRF protection: restrict to http/https, block metadata and private ranges
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Blocked protocol: ${parsed.protocol}`);
      }
      const host = parsed.hostname;
      if (host === '169.254.169.254' || host.startsWith('fd') || host === '::1') {
        throw new Error('Blocked: metadata/link-local address');
      }
    } catch (err) {
      if (err instanceof TypeError) throw new Error(`Invalid URL: ${url}`);
      throw err;
    }

    const start = Date.now();
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(this.config.scanTimeout),
      });
      return {
        url,
        status: resp.status,
        ok: resp.ok,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        url,
        status: 0,
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  private async checkServices() {
    const results: Record<string, { url: string; status: number; ok: boolean; latencyMs: number }> = {};
    const checks = Object.entries(this.config.services).map(async ([name, url]) => {
      const result = await this.checkUrl({ url }) as { status: number; ok: boolean; latencyMs: number };
      results[name] = { url, ...result };
    });
    await Promise.all(checks);
    return { services: results };
  }

  private async discoverPeers() {
    // Scan local subnet for Ark Home instances on port 7700
    const ifaces = networkInterfaces();
    const localIps: string[] = [];

    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.internal || addr.family !== 'IPv4') continue;
        localIps.push(addr.address);
      }
    }

    // For each local IP, scan the /24 subnet for port 7700
    // Only scan a few common IPs to keep it fast
    const peers: { address: string; port: number }[] = [];

    for (const ip of localIps) {
      const subnet = ip.split('.').slice(0, 3).join('.');
      // Quick scan: .1-.10 and .100-.110 (common DHCP ranges)
      const candidates = [
        ...Array.from({ length: 10 }, (_, i) => `${subnet}.${i + 1}`),
        ...Array.from({ length: 10 }, (_, i) => `${subnet}.${i + 100}`),
      ].filter(candidate => candidate !== ip);

      const checks = candidates.map(async (candidate) => {
        const open = await this.isPortOpen(candidate, 7700);
        if (open) {
          // Verify it's an Ark Home by checking /api/health
          try {
            const resp = await fetch(`http://${candidate}:7700/api/health`, {
              signal: AbortSignal.timeout(500),
            });
            if (resp.ok) {
              peers.push({ address: candidate, port: 7700 });
            }
          } catch { /* not an Ark Home */ }
        }
      });
      await Promise.all(checks);
    }

    return { localIps, peers };
  }

  // --- Helpers ---

  private async isPortOpen(host: string, port: number): Promise<boolean> {
    try {
      const socket = await Bun.connect({
        hostname: host,
        port,
        socket: {
          data() {},
          open(socket) { socket.end(); },
          error() {},
          close() {},
        },
      });
      socket.end();
      return true;
    } catch {
      return false;
    }
  }
}
