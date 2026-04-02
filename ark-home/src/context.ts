// Ark Home — Context Manager
// Each context (personal/business/home) is an isolated namespace.
// In Phase 2, these become COW-branched rvf stores.
// For Phase 1, they're separate JSONL sections with metadata filtering.

import type { Context, ArkHomeConfig } from './types';

export class ContextManager {
  private activeContext: Context;
  private contexts: Context[];

  constructor(config: ArkHomeConfig) {
    this.activeContext = config.activeContext;
    this.contexts = config.contexts;
  }

  get current(): Context {
    return this.activeContext;
  }

  switch(to: Context): boolean {
    if (!this.contexts.includes(to)) return false;
    this.activeContext = to;
    return true;
  }

  list(): Context[] {
    return [...this.contexts];
  }

  // Context-specific system prompt additions
  systemPromptFor(context: Context): string {
    switch (context) {
      case 'personal':
        return 'You are managing the user\'s personal life: calendar, health, family, personal finances, hobbies. Keep this completely separate from business data.';
      case 'business':
        return 'You are managing the user\'s business: scheduling jobs, invoicing, client management, expenses, inventory, fleet. Keep this completely separate from personal data.';
      case 'home':
        return 'You are managing the user\'s home automation: energy, water, security, network, compute resources, maintenance. Keep this completely separate from personal and business data.';
    }
  }

  // Detect context from user input (simple keyword-based for Phase 1)
  detectContext(input: string): Context | null {
    const lower = input.toLowerCase();
    const businessKeywords = ['invoice', 'client', 'job', 'schedule', 'estimate', 'billing', 'customer', 'payment', 'project', 'work order'];
    const homeKeywords = ['energy', 'power', 'temperature', 'lights', 'security', 'camera', 'network', 'storage', 'backup'];
    const personalKeywords = ['family', 'doctor', 'appointment', 'vacation', 'birthday', 'grocery', 'personal'];

    if (businessKeywords.some(k => lower.includes(k))) return 'business';
    if (homeKeywords.some(k => lower.includes(k))) return 'home';
    if (personalKeywords.some(k => lower.includes(k))) return 'personal';
    return null;
  }
}
