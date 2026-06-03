// Stubs for obsidian-dev-utils subpath imports used at runtime.
import { Plugin } from './obsidian.ts';

export class PluginBase<_T> extends Plugin {
  protected settings: Record<string, unknown> = {};
  protected createSettingsManager(): unknown { return null; }
  protected createSettingsTab(): unknown { return null; }
  protected async onloadImpl(): Promise<void> {}
}

export class PluginSettingsManagerBase<_T> {}
export class PluginSettingsTabBase<_T> {
  protected containerEl = { empty: () => undefined } as unknown as HTMLElement;
  protected plugin: unknown;
  protected bind(_component: unknown, _key: unknown): void {}
  public display(): void {}
}

export interface PluginTypesBase {}
export class SettingEx {
  constructor(_el: HTMLElement) {}
  public setName(_n: string): this { return this; }
  public setDesc(_d: string): this { return this; }
  public addDropdown(_fn: (d: unknown) => void): this { return this; }
}
