// Ark Home — Docker Resource Provider
// List, start, stop, inspect containers via Docker socket.

import type { ResourceProvider, ProviderAction, ProviderHealth } from './index';

const DOCKER_SOCKET = '/var/run/docker.sock';

export class DockerProvider implements ResourceProvider {
  readonly name = 'docker';
  readonly description = 'Docker: manage containers, images, and services';
  private available = false;

  async init(): Promise<boolean> {
    try {
      const resp = await this.dockerFetch('/version');
      this.available = resp !== null;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  actions(): ProviderAction[] {
    return [
      { name: 'list', description: 'List all containers', destructive: false },
      { name: 'inspect', description: 'Inspect a container', destructive: false },
      { name: 'logs', description: 'Get container logs', destructive: false },
      { name: 'stats', description: 'Get container resource usage', destructive: false },
      { name: 'start', description: 'Start a stopped container', destructive: true },
      { name: 'stop', description: 'Stop a running container', destructive: true },
      { name: 'restart', description: 'Restart a container', destructive: true },
      { name: 'images', description: 'List images', destructive: false },
    ];
  }

  async execute(action: string, args: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'list': return this.listContainers(args);
      case 'inspect': return this.inspectContainer(args);
      case 'logs': return this.containerLogs(args);
      case 'stats': return this.containerStats(args);
      case 'start': return this.startContainer(args);
      case 'stop': return this.stopContainer(args);
      case 'restart': return this.restartContainer(args);
      case 'images': return this.listImages();
      default: throw new Error(`Unknown docker action: ${action}`);
    }
  }

  async health(): Promise<ProviderHealth> {
    try {
      const version = await this.dockerFetch('/version') as Record<string, unknown> | null;
      return {
        available: version !== null,
        details: version ? `Docker ${version.Version}` : 'unavailable',
      };
    } catch {
      return { available: false, details: 'Docker socket not accessible' };
    }
  }

  // --- Actions ---

  private async listContainers(args: Record<string, unknown>) {
    const all = args.all !== false; // show stopped by default
    const data = await this.dockerFetch(`/containers/json?all=${all}`);
    if (!Array.isArray(data)) return { containers: [] };

    return {
      containers: data.map((c: Record<string, unknown>) => ({
        id: String(c.Id).slice(0, 12),
        name: Array.isArray(c.Names) ? (c.Names[0] as string)?.replace(/^\//, '') : '',
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports,
      })),
    };
  }

  private async inspectContainer(args: Record<string, unknown>) {
    const id = requireArg(args, 'id');
    return this.dockerFetch(`/containers/${id}/json`);
  }

  private async containerLogs(args: Record<string, unknown>) {
    const id = requireArg(args, 'id');
    const tail = Number(args.tail) || 100;
    const resp = await this.dockerFetchRaw(`/containers/${id}/logs?stdout=true&stderr=true&tail=${tail}`);
    if (!resp) return { logs: '' };
    const text = await resp.text();
    // Docker log format has 8-byte header per line, strip it
    const lines = text.split('\n').map(line => line.length > 8 ? line.slice(8) : line);
    return { logs: lines.join('\n') };
  }

  private async containerStats(args: Record<string, unknown>) {
    const id = requireArg(args, 'id');
    return this.dockerFetch(`/containers/${id}/stats?stream=false`);
  }

  private async startContainer(args: Record<string, unknown>) {
    const id = requireArg(args, 'id');
    await this.dockerFetchRaw(`/containers/${id}/start`, 'POST');
    return { action: 'started', container: id };
  }

  private async stopContainer(args: Record<string, unknown>) {
    const id = requireArg(args, 'id');
    await this.dockerFetchRaw(`/containers/${id}/stop`, 'POST');
    return { action: 'stopped', container: id };
  }

  private async restartContainer(args: Record<string, unknown>) {
    const id = requireArg(args, 'id');
    await this.dockerFetchRaw(`/containers/${id}/restart`, 'POST');
    return { action: 'restarted', container: id };
  }

  private async listImages() {
    const data = await this.dockerFetch('/images/json');
    if (!Array.isArray(data)) return { images: [] };

    return {
      images: data.map((img: Record<string, unknown>) => ({
        id: String(img.Id).slice(7, 19),
        tags: img.RepoTags,
        size: img.Size,
        created: img.Created,
      })),
    };
  }

  // --- Docker socket helpers ---

  private async dockerFetch(path: string, method = 'GET'): Promise<unknown> {
    const resp = await this.dockerFetchRaw(path, method);
    if (!resp) return null;
    return resp.json();
  }

  private async dockerFetchRaw(path: string, method = 'GET'): Promise<Response | null> {
    try {
      return await fetch(`http://localhost${path}`, {
        method,
        // @ts-expect-error -- Bun supports unix socket via this option
        unix: DOCKER_SOCKET,
      });
    } catch {
      return null;
    }
  }
}

function requireArg(args: Record<string, unknown>, name: string): string {
  const val = args[name];
  if (!val || typeof val !== 'string') throw new Error(`Missing required arg: ${name}`);
  return val;
}
